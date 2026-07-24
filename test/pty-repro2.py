# 复现第 2 轮:回答完成后连续操作 — 空回车、第二个问题,看进程是否退出
import time
import threading
from winpty import PtyProcess

NODE = r'C:\nvm4w\nodejs\node.exe'   # 与用户一致的系统 node 25
CWD = r'C:\workspace\github_workspace\zen-gitsync'
LOG = r'C:\workspace\github_workspace\zen-gitsync\test\pty-repro2.log'

cmd = ['cmd.exe', '/c', 'npm', 'run', 'g:ai']   # 与用户一致的 npm run 启动
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

time.sleep(8)
print('boot alive:', proc.isalive(), flush=True)

proc.write('你好\r')
print('sent Q1', flush=True)
time.sleep(40)
print('after Q1 alive:', proc.isalive(), flush=True)
if not proc.isalive():
    print('EXITED AFTER Q1, exitcode:', proc.exitcode, flush=True)
    raise SystemExit

# 空回车(用户可能随手按一下)
proc.write('\r')
time.sleep(3)
print('after empty enter alive:', proc.isalive(), flush=True)
if not proc.isalive():
    print('EXITED AFTER EMPTY ENTER, exitcode:', proc.exitcode, flush=True)
    raise SystemExit

# 第二个问题
proc.write('1+1=?\r')
print('sent Q2', flush=True)
time.sleep(40)
print('after Q2 alive:', proc.isalive(), flush=True)
if not proc.isalive():
    print('EXITED AFTER Q2, exitcode:', proc.exitcode, flush=True)
    raise SystemExit

proc.write('/exit\r')
time.sleep(3)
print('after /exit alive:', proc.isalive(), flush=True)
if proc.isalive():
    proc.terminate()
print('DONE', flush=True)
