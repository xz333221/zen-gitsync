export function registerBranchStatusRoutes({
  app,
  execGitCommand,
  getIsGitRepo,
  getCurrentBranchCache,
  setCurrentBranchCache,
  getUpstreamBranchCache,
  setUpstreamBranchCache,
  getBranchStatusCache,
  setBranchStatusCache,
  getRecentPushStatus,
  setRecentPushStatus
}) {
  async function getCurrentBranchOptimized(forceRefresh = false) {
    const now = Date.now();
    const currentBranchCache = getCurrentBranchCache();

    if (!forceRefresh &&
        currentBranchCache.branchName &&
        (now - currentBranchCache.lastUpdate) < currentBranchCache.cacheTimeout) {
      console.log(`使用缓存的分支名: ${currentBranchCache.branchName}`);
      return currentBranchCache.branchName;
    }

    const { stdout } = await execGitCommand('git symbolic-ref --short HEAD');
    const branchName = stdout.trim();

    setCurrentBranchCache({
      branchName,
      lastUpdate: now,
      cacheTimeout: 300000
    });

    return branchName;
  }

  async function getUpstreamBranchOptimized(forceRefresh = false) {
    const now = Date.now();
    const upstreamBranchCache = getUpstreamBranchCache();

    if (!forceRefresh &&
        upstreamBranchCache.upstreamBranch !== null &&
        (now - upstreamBranchCache.lastUpdate) < upstreamBranchCache.cacheTimeout) {
      console.log(`使用缓存的上游分支: ${upstreamBranchCache.upstreamBranch}`);
      return upstreamBranchCache.upstreamBranch;
    }

    console.log('重新获取上游分支...');
    const { stdout: upstreamOutput } = await execGitCommand(
      'git rev-parse --abbrev-ref --symbolic-full-name @{u}',
      { ignoreError: true }
    );
    const upstreamBranch = upstreamOutput.trim() || null;

    setUpstreamBranchCache({
      upstreamBranch,
      lastUpdate: now,
      cacheTimeout: 300000
    });

    return upstreamBranch;
  }

  // 获取当前分支 - 使用缓存优化
  app.get('/api/branch', async (req, res) => {
    try {
      const forceRefresh = req.query.force === 'true';
      const branch = await getCurrentBranchOptimized(forceRefresh);
      res.json({ branch });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 获取分支与远程的差异状态（领先/落后提交数）- 优化版本
  app.get('/api/branch-status', async (req, res) => {
    try {
      if (!getIsGitRepo()) {
        return res.json({ hasUpstream: false, ahead: 0, behind: 0 });
      }

      const now = Date.now();
      const forceRefresh = req.query.force === 'true';
      const refreshCountOnly = req.query.countOnly === 'true';

      const recentPushStatus = getRecentPushStatus();
      const branchStatusCache = getBranchStatusCache();

      if (recentPushStatus.justPushed &&
          (now - recentPushStatus.pushTime) < recentPushStatus.validDuration) {
        console.log('检测到最近推送过，直接返回同步状态');
        return res.json({
          hasUpstream: true,
          upstreamBranch: branchStatusCache.upstreamBranch || 'origin/main',
          ahead: 0,
          behind: 0
        });
      }

      const branchInfoCacheValid = branchStatusCache.currentBranch &&
                                   branchStatusCache.upstreamBranch &&
                                   (now - branchStatusCache.lastUpdate) < branchStatusCache.cacheTimeout;

      if ((refreshCountOnly && branchInfoCacheValid) || (!forceRefresh && branchInfoCacheValid)) {
        const { stdout: aheadBehindOutput } = await execGitCommand(
          `git rev-list --left-right --count ${branchStatusCache.currentBranch}...${branchStatusCache.upstreamBranch}`
        );
        const [ahead, behind] = aheadBehindOutput.trim().split('\t').map(Number);

        console.log(`使用缓存的分支信息: ${branchStatusCache.currentBranch} -> ${branchStatusCache.upstreamBranch} (${refreshCountOnly ? '只刷新计数' : '缓存有效'})`);

        return res.json({
          hasUpstream: true,
          upstreamBranch: branchStatusCache.upstreamBranch,
          ahead,
          behind
        });
      }

      const currentBranchCache = getCurrentBranchCache();
      const upstreamBranchCache = getUpstreamBranchCache();

      const shouldForceRefreshBranch = forceRefresh &&
        (!currentBranchCache.branchName ||
         (Date.now() - currentBranchCache.lastUpdate) >= currentBranchCache.cacheTimeout);

      const currentBranch = await getCurrentBranchOptimized(shouldForceRefreshBranch);

      const shouldForceRefreshUpstream = forceRefresh &&
        (upstreamBranchCache.upstreamBranch === null ||
         (Date.now() - upstreamBranchCache.lastUpdate) >= upstreamBranchCache.cacheTimeout);

      const upstreamBranch = await getUpstreamBranchOptimized(shouldForceRefreshUpstream);

      if (!upstreamBranch) {
        setBranchStatusCache({
          currentBranch: null,
          upstreamBranch: null,
          lastUpdate: 0,
          cacheTimeout: 5000
        });
        return res.json({ hasUpstream: false, ahead: 0, behind: 0 });
      }

      setBranchStatusCache({
        currentBranch,
        upstreamBranch,
        lastUpdate: now,
        cacheTimeout: 5000
      });

      const { stdout: aheadBehindOutput } = await execGitCommand(
        `git rev-list --left-right --count ${currentBranch}...${upstreamBranch}`
      );
      const [ahead, behind] = aheadBehindOutput.trim().split('\t').map(Number);

      res.json({
        hasUpstream: true,
        upstreamBranch,
        ahead,
        behind
      });
    } catch (error) {
      console.error('获取分支状态失败:', error);
      res.status(500).json({ error: error.message });
    }
  });
}
