
/*
  Generic webhook handler for BitBucket, GitHub, GitLab
  Benoît Hubert

  Inspired by https://github.com/rolfn/node-gitlab-hook  (Rolf Niepraschk)
  Inspired by https://github.com/nlf/node-github-hook    (Nathan LaFreniere)
*/

var Http = require('http');
var Url = require('url');
var Fs = require('fs');
var execFile = require('child_process').execFile;
var Path = require('path');
var Os = require('os');
var Tmp = require('temp'); Tmp.track();
var Util = require('util');
var ipRangeCheck = require("ip-range-check");

// per-provider IPs
var ipRanges = {

  // source: https://confluence.atlassian.com/bitbucket/what-are-the-bitbucket-cloud-ip-addresses-i-should-use-to-configure-my-corporate-firewall-343343385.html
  bitbucket: ['104.192.143.192/28', '104.192.143.208/28', '104.192.143.0/24', '34.198.203.127', '34.198.178.64'],

  // source: https://help.github.com/articles/github-s-ip-addresses/#service-hook-ip-addresses
  github: ['192.30.252.0/22', '85.199.108.0/22'],

  // source: https://gitlab.com/gitlab-com/infrastructure/issues/434
  // gitlab: []
}

function checkIp(req) {
  const ip = req.ip || req.headers['x-real-ip'];
  console.log('checkIp', req.ip, req.headers['x-real-ip'], '=>', ip);
  for(provider in ipRanges) {
    console.log(ipRanges[provider]);
    var ipRangesForProvider = ipRanges[provider];
    var matches = ipRangesForProvider.reduce(function(carry, range) {
      console.log('check ip vs range vs ip', ip, range, ipRangeCheck(req.ip, range));
      return carry || ipRangeCheck(ip, range);
    }, false);
    if(matches) {
      return provider;
    }
  }
}

var originatorCheckers = {
  bitbucket: checkIp,
  github: checkIp,
  gitlab: function(req) {
    console.log('gitlab orig check', headers);
    return req.headers['x-gitlab-event'] !== undefined;
  }
}

var securityCheckers = {
  bitbucket: function(headers, config) {
    return { success: true };
  },

  gitlab: function(headers, config) {
    if(config.secretToken === undefined && headers['x-gitlab-token'] === undefined) {
      return { success: true };
    }
    if(config.secretToken === undefined && headers['x-gitlab-token'] !== undefined) {
      return {
        success: false,
        reason: 'Secret token set in GitLab but not expected'
      }
    }
    else if(config.secretToken !== undefined && headers['x-gitlab-token'] == undefined) {
      return {
        success: false,
        reason: 'Secret token expected but not set in GitLab'
      }
    }
    else {
      var payload = {
        success: config.secretToken === headers['x-gitlab-token']
      };
      if(! payload.success) {
        payload.reason = 'Secret token does not match expected value (received: ' +
          headers['x-gitlab-token'] + ', expected: ' + config.secretToken + ')';
      }
      return payload;
    }
  },

  github: function(headers, config) {
    console.log('## headers for GitHub', headers);
    return { success: true };
  },

}

var inspect = Util.inspect;
var isArray = Util.isArray;

var WebhookListener = function(_options, _callback) {
  if (!(this instanceof WebhookListener)) return new WebhookListener(_options, _callback);
  var callback = null, options = null;
  if (typeof _options === 'function') {
    callback = _options;
  } else {
    callback = _callback;
    options =  _options;
  }
  options = options || {};
  this.configFile = options.configFile || 'WebhookListener.conf';
  this.configPathes = options.configPathes ||
    ['/etc/WebhookListener/', '/usr/local/etc/WebhookListener/', '.'];
  this.port = options.port || 3420;
  this.host = options.host || '0.0.0.0';
  this.secretToken = options.secretToken;
  this.cmdshell = options.cmdshell || '/bin/sh';
  this.keep = (typeof options.keep === 'undefined') ? false : options.keep;
  this.logger = options.logger;
  this.callback = callback;
  this.allOptions = options;

  var active = false, tasks;

  if (typeof callback == 'function') {
    active = true;
  } else {
    cfg = readConfigFile(this.configPathes, this.configFile);
    if (cfg) {
      this.logger.info('loading config file: ' + this.configFile);
      this.logger.info('config file:\n' + Util.inspect(cfg));
      for (var i in cfg) {
        if (i == 'tasks' && typeof cfg.tasks == 'object' &&
            Object.keys(cfg.tasks).length) {
          this.tasks = cfg.tasks;
          active = true;
        } else {
          this[i] = cfg[i];
        }
      }
    } else {
      this.logger.error("can't read config file: ", this.configFile);
    }
  }

  this.logger = this.logger || { info: function(){}, error: function(){} };

  this.logger.info('self: ' + inspect(this) + '\n');

  if (active) this.server = Http.createServer(serverHandler.bind(this));
};

WebhookListener.prototype.listen = function(callback) {
  var self = this;
  if (typeof self.server !== 'undefined') {
    self.server.listen(self.port, self.host, function () {
      self.logger.info(Util.format(
        'listening for github events on %s:%d', self.host, self.port));
      if (typeof callback === 'function') callback();
    });
  } else {
    self.logger.info('server disabled');
  }
};

function readConfigFile(pathes, file) {
  var fname, ret = false;
  for (var i=0;i<pathes.length;i++) {
    fname = Path.join(pathes[i], file);
    try {
      var data = Fs.readFileSync(fname, 'utf-8');
      ret = parse(data);
      break;
    } catch(err) {
    }
  }
  return ret;
}

function parse(data) {
    var result;
    try {
        result = JSON.parse(data);
    } catch (e) {
        result = false;
    }
    return result;
}

function reply(statusCode, res) {
  var headers = {
    'Content-Length': 0
  };
  res.writeHead(statusCode, headers);
  res.end();
}

function executeShellCmds(self, address, data) {
  var repo = data.repository.name;
  var lastCommit = data.commits ? data.commits[data.commits.length-1] : null;
  var map = {
    '%r': repo,
    '%k': data.object_kind,
    '%g': data.repository ? data.repository.git_ssh_url : '',
    '%h': data.repository ? data.repository.git_http_url : '',
    '%u': data.user_name,
    '%b': data.ref,
    '%i': lastCommit ? lastCommit.id : '',
    '%t': lastCommit ? lastCommit.timestamp : '',
    '%m': lastCommit ? lastCommit.message : '',
    '%s': address
  };

  function execute(path, idx) {
    if (idx == cmds.length) {
      if (!self.keep) {
       self.logger.info('Remove working directory: ' + self.path);
       Tmp.cleanup();
      } else {
        self.logger.info('Keep working directory: ' + self.path);
      }
      return;
    }
    var fname = Path.join(path, 'task-' + pad(idx, 3));
    Fs.writeFile(fname, cmds[idx], function (err) {
      if (err) {
        self.logger.error('File creation error: ' + err);
        return;
      }
      self.logger.info('File created: ' + fname);
      execFile(self.cmdshell, [ fname ], { cwd:path, env:process.env },
        function (err, stdout, stderr) {
        if (err) {
          self.logger.error('Exec error: ' + err);
        } else {
          self.logger.info('Executed: ' + self.cmdshell + ' ' + fname);
          process.stdout.write(stdout);
        }
        process.stderr.write(stderr);
        execute(path, ++idx);
      });
    });
  }

  var cmds = getCmds(self.tasks, map, repo);

  if (cmds.length > 0) {

    self.logger.info('cmds: ' + inspect(cmds) + '\n');

    Tmp.mkdir({dir:Os.tmpDir(), prefix:'WebhookListener.'}, function(err, path) {
      if (err) {
        self.logger.error(err);
        return;
      }
      self.path = path;
      self.logger.info('Tempdir: ' + path);
      var i = 0;
      execute(path, i);
    });

  } else {
    self.logger.info('No related commands for repository "' + repo + '"');
  }
}

/**
 * Get provider (gitlab, github, bitbucket) from IP address
 */
function getProvider(ip) {

}

function serverHandler(req, res) {
  var self = this;
  var url = Url.parse(req.url, true);
  var buffer = [];
  var bufferLength = 0;
  var failed = false;
  var remoteAddress = req.ip || req.socket.remoteAddress ||
    req.socket.socket.remoteAddress;

  req.on('data', function (chunk) {
    if (failed) return;
    buffer.push(chunk);
    bufferLength += chunk.length;
  });

  req.on('end', function (chunk) {
    if (failed) return;
    var data;

    if (chunk) {
      buffer.push(chunk);
      bufferLength += chunk.length;
    }

    self.logger.info(Util.format('received %d bytes from %s\n\n', bufferLength,
      remoteAddress));

    data = Buffer.concat(buffer, bufferLength).toString();
    data = parse(data);

    // invalid json
    if (!data || !data.repository || !data.repository.name) {
       self.logger.error(Util.format('received invalid data from %s, returning 400\n\n',
         remoteAddress));
      return reply(400, res);
    }

    var repo = data.repository.name;

    reply(200, res);

    self.logger.info(Util.format('got event on %s:%s from %s\n\n', repo, data.ref,
      remoteAddress));
    self.logger.info(Util.inspect(data, { showHidden: true, depth: 10 }) + '\n\n');


    if (typeof self.callback == 'function') {
      self.callback(data);
    } else {
      executeShellCmds(self, remoteAddress, data);
    }

  });

  console.log('### checking originator', Object.keys(originatorCheckers), req);
  for(provider in originatorCheckers) {
    console.log('  # checking', provider, '=>', originatorCheckers[provider](req));
    if(originatorCheckers[provider](req)) {
      console.log('found!! provider:', provider);
      break;
    }
  }
  var providerConfig = this.allOptions[provider] || {};
  var securityCheckResult = securityCheckers[provider](req.headers);
  console.log('## security check, conf for provider... ok ?', provider, providerConfig, securityCheckResult);

  if(this.secretToken && req.headers['x-gitlab-token'] !== this.secretToken) {
    return reply(401, res);
  }
  // 405 if the method is wrong
  if (req.method !== 'POST') {
      self.logger.error(Util.format('got invalid method from %s, returning 405',
        remoteAddress));
      failed = true;
      return reply(405, res);
  }

}

function getCmds(tasks, map, repo) {
  var ret = [], x = [];
  if (tasks.hasOwnProperty('*')) x.push(tasks['*']);
  if (tasks.hasOwnProperty(repo)) x.push(tasks[repo]);
  for (var i=0; i<x.length; i++) {
    var cmdStr = (isArray(x[i])) ? x[i].join('\n') : x[i];
    for (var j in map) cmdStr = cmdStr.replace(new RegExp(j, 'g'), map[j]);
    ret.push(cmdStr + '\n');
  }
  return ret;
}

function pad(n, width, z) {
  z = z || '0';
  n = n + '';
  return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
}

module.exports = WebhookListener;

