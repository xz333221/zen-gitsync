export function createRequestLogger({ chalk }) {
  return (req, res, next) => {
    const startTime = Date.now();
    const requestTime = new Date().toLocaleString('zh-CN', { hour12: false });

    res.on('finish', () => {
      const duration = Date.now() - startTime;
      const statusCode = res.statusCode;

      let statusColor = chalk.green;
      if (statusCode >= 400 && statusCode < 500) {
        statusColor = chalk.yellow;
      } else if (statusCode >= 500) {
        statusColor = chalk.red;
      }

      let durationColor = chalk.gray;
      if (duration > 1000) {
        durationColor = chalk.red;
      } else if (duration > 500) {
        durationColor = chalk.yellow;
      } else if (duration > 200) {
        durationColor = chalk.cyan;
      }

      console.log(
        chalk.dim(`[${requestTime}]`),
        chalk.bold(req.method),
        req.url,
        statusColor(`[${statusCode}]`),
        durationColor(`${duration}ms`)
      );
    });

    next();
  };
}
