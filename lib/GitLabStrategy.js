const getExtractEventFunc = require('./getExtractEventFunc');

/**
 * Constructor
 */
function GitLabStrategy(headers) {
  this.headers = headers;
  this.event = headers['x-gitlab-event'];
}

/**
 * Perform security check (check against x-gitlab-token header)
 */
GitLabStrategy.prototype.securityCheck = function(config) {
  var tokenHeader = this.headers['x-gitlab-token'];
  console.log('GitLabStrategy.securityCheck', this.headers, config, tokenHeader);
  if(config.secretToken === undefined && tokenHeader === undefined) {
    return { success: true };
  }
  if(config.secretToken === undefined && tokenHeader !== undefined) {
    return {
      success: false,
      reason: 'Secret token set in GitLab but not expected'
    }
  }
  else if(config.secretToken !== undefined && tokenHeader === undefined) {
    return {
      success: false,
      reason: 'Secret token expected but not set in GitLab'
    }
  }
  else {
    var payload = {
      success: config.secretToken === tokenHeader
    };
    if(! payload.success) {
      payload.reason = 'Secret token does not match expected value (received: ' +
        tokenHeader + ', expected: ' + config.secretToken + ')';
    }
    return payload;
  }
};

/**
 * Populate with parsed body
 */
GitLabStrategy.prototype.setData = function(data) {
  this.data = data;
  if(data.object_attributes) {
    this.action = data.object_attributes.action;
  }
}

/**
 * Map GitLab event to BitBucket event name
 */
GitLabStrategy.prototype.mapEventName = function() {
  const map = {
    'Push Hook': 'repo:push'
  }
  return map[this.event];
}

/**
 * Map GitLab event to BitBucket event name
 */
GitLabStrategy.prototype.mapAction = function() {
  const map = {
    'Push Hook': {
      event: 'repo:push',
      funcName: 'extractRepoPush'
    },
    'Issue Hook': {
      update: {
        event: 'issue:updated',
        funcName: 'extractIssue'
      },
      open: {
        event: 'issue:created',
        funcName: 'extractIssue'
      }
    },
    'Merge Request Hook': {
      open: {
        event: 'pullrequest:created',
        funcName: 'extractPullRequest'
      },
      update: {
        event: 'pullrequest:updated',
        funcName: 'extractPullRequest'
      }
    }
  }
  if(map[this.event] === undefined) {
    throw new Error('unhandled event: ' + this.event);
  }
  if(this.action === undefined) {
    return map[this.event];
  }
  else if(map[this.event][this.action] === undefined) {
      throw new Error('unhandled event action: ' + this.event + ':' + this.action);
  }
  return map[this.event][this.action];
}

GitLabStrategy.prototype.getEventData = function() {
  const { event, funcName } = this.mapAction();
  const data = this[funcName]();
  return {
    event,
    data
  };
}


GitLabStrategy.prototype.getRepoData = function(project, repository) {
  return {
    name: project.name,
    fullName: project.path_with_namespace,
    url: project.web_url
  }
}

GitLabStrategy.prototype.mapIssueState = function(origState) {
  const map = {
    opened: 'open',
    closed: 'closed'
  }
  return map[origState];
}


GitLabStrategy.prototype.getIssueData = function(issue) {
  const { iid, url, title, description, state } = issue;
  return {
    number: iid,
    title,
    body: description,
    state: this.mapIssueState(state),
    htmlUrl: url
  };
}

GitLabStrategy.prototype.getPullRequestData = function(pullRequest) {
  const { iid, title, description, state, url, source_branch, target_branch, source, target } = pullRequest;
  return {
    number: iid,
    title,
    body: description,
    state: this.mapIssueState(state),
    htmlUrl: url,
    sourceBranch: source_branch,
    sourceRepo: this.getRepoData(source),
    targetBranch: target_branch,
    targetRepo: this.getRepoData(target)
  };
}
GitLabStrategy.prototype.extractIssue = function() {
  const { project, repository, object_attributes } = this.data;
  const repoData = this.getRepoData(project, repository);
  const issueData = this.getIssueData(object_attributes);
  return {
    repository: repoData,
    issue: issueData
  };
}

GitLabStrategy.prototype.extractRepoPush = function() {
  const { project, repository } = this.data;
  return {
    repository: this.getRepoData(project, repository)
  };
}

GitLabStrategy.prototype.extractPullRequest = function() {
  const { project, repository, object_attributes } = this.data;
  const repoData = this.getRepoData(project);
  const pullRequestData = this.getPullRequestData(object_attributes);
  return {
    repository: repoData,
    pullRequest: pullRequestData
  };
}
module.exports = GitLabStrategy;