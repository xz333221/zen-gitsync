# 一次性复现:在真实 ConPTY 里跑 npm run g:ai(复刻用户截图的启动方式)
import time
import threading
from winpty import PtyProcess

CWD = r'C:\workspace\github_workspace\zen-gitsync'
LOG = r'C:\workspace\github_workspace\zen-gitsync\test\pty-repro-npm.log'

cmd = ['cmd.exe', '/c', 'npm', 'run', 'g:ai']
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

threading.Thread(target=reader, daemon=True).start()

time.sleep(8)   # npm 启动慢一些
print('alive after boot:', proc.isalive(), flush=True)

proc.write('你好\r')
print('sent 你好, waiting...', flush=True)

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
    proc.write('/exit\r')
    time.sleep(3)
    print('alive after /exit:', proc.isalive(), flush=True)
    if proc.isalive():
        proc.terminate()

log.close()
print('DONE — 完整输出在 test/pty-repro-npm.log', flush=True)
