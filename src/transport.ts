import { request } from 'node:https';

export function secureFetch(
    url: string,
    authorization?: string,
    ca?: string,
): Promise<Response> {
    if (new URL(url).protocol !== 'https:') {
        throw new Error('MPP requires HTTPS');
    }

    return new Promise((resolve, reject) => {
        const req = request(
            url,
            {
                method: 'GET',
                minVersion: 'TLSv1.2',
                ca,
                headers: authorization ? { authorization } : {},
            },
            (response) => {
                const chunks: Buffer[] = [];
                let size = 0;

                response.on('data', (chunk: Buffer) => {
                    size += chunk.length;

                    if (size > 1_048_576) {
                        req.destroy(new Error('Response exceeds 1 MiB'));
                    } else {
                        chunks.push(chunk);
                    }
                });
                response.on('error', reject);
                response.on('end', () => {
                    const headers = new Headers();

                    for (const [key, value] of Object.entries(response.headers)) {
                        if (typeof value === 'string') {
                            headers.set(key, value);
                        } else if (value) {
                            for (const item of value) {
                                headers.append(key, item);
                            }
                        }
                    }

                    resolve(
                        new Response(Buffer.concat(chunks), {
                            status: response.statusCode,
                            headers,
                        }),
                    );
                });
            },
        );

        req.setTimeout(90_000, () =>
            req.destroy(
                new Error('Request timed out; inspect payment before retrying'),
            ),
        );
        req.on('error', reject);
        req.end();
    });
}
