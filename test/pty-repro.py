# 一次性复现脚本:在真实 ConPTY 里跑 g ai,发"你好",观察回答后进程是否退出
# 读线程持续收输出(后台 daemon),主线程按时间线驱动 + 断言进程存活状态
import sys
import time
import threading
from winpty import PtyProcess

NODE = r'C:\Users\xuze3\.workbuddy\binaries\node\versions\22.22.2\node.exe'
CWD = r'C:\workspace\github_workspace\zen-gitsync'
LOG = r'C:\workspace\github_workspace\zen-gitsync\test\pty-repro.log'

cmd = [NODE, r'src\gitCommit.js', 'ai'] + sys.argv[1:]
print('SPAWN:', cmd, flush=True)
proc = PtyProcess.spawn(cmd, cwd=CWD, dimensions=(24, 100))

log = open(LOG, 'w', encoding='utf-8', errors='replace')

def reader():
    while True:
        try:
            data = proc.read(1024)
        except Exception:
            break
        if not data:
            break
        log.write(data)
        log.flush()

t = threading.Thread(target=reader, daemon=True)
t.start()

# 1. 等启动横幅 + 输入框画完
time.sleep(5)
print('alive after boot:', proc.isalive(), flush=True)

# 2. 发送"你好" + 回车
proc.write('你好\r')
print('sent 你好, waiting for answer...', flush=True)

# 3. 等模型回答(最多 60 秒),每 5 秒报一次存活状态
for i in range(12):
    time.sleep(5)
    print(f'[{(i+1)*5:>3}s] alive: {proc.isalive()}', flush=True)
    if not proc.isalive():
        break

alive = proc.isalive()
print('alive after answer window:', alive, flush=True)
if not alive:
    print('exitcode:', proc.exitcode, flush=True)
else:
    # 还活着:发 /exit 验证交互仍然可用
    proc.write('/exit\r')
    time.sleep(3)
    print('alive after /exit:', proc.isalive(), flush=True)
    if proc.isalive():
        proc.terminate()

log.close()
print('DONE — 完整输出在 test/pty-repro.log', flush=True)
