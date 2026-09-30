# Sends admin commands to a Soldat 1.7.1 server (TCP, same port as the game).
import socket, sys, time
host, port, password = sys.argv[1], int(sys.argv[2]), sys.argv[3]
cmds = sys.argv[4:]
s = socket.create_connection((host, port), timeout=5)
s.sendall((password + '\r\n').encode())
time.sleep(0.5)
for c in cmds:
    s.sendall((c + '\r\n').encode())
    time.sleep(0.5)
s.settimeout(1.5)
out = b''
try:
    while True:
        d = s.recv(65536)
        if not d: break
        out += d
except Exception:
    pass
print(out.decode('latin1', 'replace')[-1500:])
s.close()
