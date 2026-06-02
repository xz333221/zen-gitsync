// 实例注册表 API 路由
// 当前只暴露只读列表；停止/启停他人实例属于 out-of-scope（v1 只做跳转导航）

export function registerInstancesRoutes({ app, registry, getCurrentInstanceId }) {
  // 获取所有活跃实例（自动 prune 失效条目）
  app.get('/api/instances', async (req, res) => {
    try {
      const instances = await registry.list({ pruneStale: true });
      const currentInstanceId = typeof getCurrentInstanceId === 'function'
        ? getCurrentInstanceId()
        : null;
      res.json({
        success: true,
        instances,
        currentInstanceId
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error?.message || String(error)
      });
    }
  });
}
