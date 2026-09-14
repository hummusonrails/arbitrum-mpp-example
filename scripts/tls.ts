import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function createTls(directory?: string) {
    const path = directory ?? (await mkdtemp(join(tmpdir(), 'mpp-tls-')));

    await mkdir(path, { recursive: true });
    const keyPath = join(path, 'key.pem');
    const certPath = join(path, 'cert.pem');

    execFileSync(
        'openssl',
        [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-days',
            '7',
            '-keyout',
            keyPath,
            '-out',
            certPath,
            '-subj',
            '/CN=localhost',
            '-addext',
            'subjectAltName=DNS:localhost,IP:127.0.0.1',
        ],
        { stdio: 'ignore' },
    );

    return {
        key: await readFile(keyPath, 'utf8'),
        cert: await readFile(certPath, 'utf8'),
        cleanup: () => rm(path, { recursive: true, force: true }),
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await createTls('.local/tls');
    console.log('Created .local/tls/cert.pem and key.pem for localhost.');
}
