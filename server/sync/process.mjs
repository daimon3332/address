import { spawn } from 'node:child_process';

export const runProcess = ({ file, args = [], env = process.env, stdio = 'inherit' }) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { env, stdio, windowsHide: true });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`${file} exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
  });
});

export const shellCommand = (command) => process.platform === 'win32'
  ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
  : { file: '/bin/sh', args: ['-lc', command] };
