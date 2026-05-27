export function registerBranchStatusRoutes({
  app,
  execGitCommand,
  getIsGitRepo,
  getBranchStatusCache,
  setBranchStatusCache,
  getRecentPushStatus,
  setRecentPushStatus
}) {
  // 获取当前分支 - 直接读取，不缓存（git symbolic-ref 极快，<5ms）
  app.get('/api/branch', async (req, res) => {
    try {
      const { stdout } = await execGitCommand('git symbolic-ref --short HEAD');
      res.json({ branch: stdout.trim() });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 获取分支与远程的差异状态（领先/落后提交数）
  app.get('/api/branch-status', async (req, res) => {
    try {
      if (!getIsGitRepo()) {
        return res.json({ hasUpstream: false, ahead: 0, behind: 0 });
      }

      const now = Date.now();
      const forceRefresh = req.query.force === 'true';

      const recentPushStatus = getRecentPushStatus();
      const branchStatusCache = getBranchStatusCache();

      // push 后10秒内直接返回同步状态
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

      // 5秒缓存分支名，防止短时间内重复执行 git symbolic-ref / git rev-parse
      const branchInfoCacheValid = !forceRefresh &&
                                   branchStatusCache.currentBranch &&
                                   branchStatusCache.upstreamBranch &&
                                   (now - branchStatusCache.lastUpdate) < branchStatusCache.cacheTimeout;

      let currentBranch, upstreamBranch;

      if (branchInfoCacheValid) {
        currentBranch = branchStatusCache.currentBranch;
        upstreamBranch = branchStatusCache.upstreamBranch;
        console.log(`使用5秒缓存的分支名: ${currentBranch} -> ${upstreamBranch}`);
      } else {
        // 直接读取，不再走5分钟长缓存
        const { stdout: branchOut } = await execGitCommand('git symbolic-ref --short HEAD');
        currentBranch = branchOut.trim();

        const { stdout: upstreamOut } = await execGitCommand(
          'git rev-parse --abbrev-ref --symbolic-full-name @{u}',
          { ignoreError: true }
        );
        upstreamBranch = upstreamOut.trim() || null;

        if (!upstreamBranch) {
          setBranchStatusCache({ currentBranch: null, upstreamBranch: null, lastUpdate: 0, cacheTimeout: 5000 });
          return res.json({ hasUpstream: false, ahead: 0, behind: 0 });
        }

        setBranchStatusCache({ currentBranch, upstreamBranch, lastUpdate: now, cacheTimeout: 5000 });
      }

      const { stdout: aheadBehindOutput } = await execGitCommand(
        `git rev-list --left-right --count ${currentBranch}...${upstreamBranch}`
      );
      const [ahead, behind] = aheadBehindOutput.trim().split('\t').map(Number);

      res.json({ hasUpstream: true, upstreamBranch, ahead, behind });
    } catch (error) {
      console.error('获取分支状态失败:', error);
      res.status(500).json({ error: error.message });
    }
  });
}
