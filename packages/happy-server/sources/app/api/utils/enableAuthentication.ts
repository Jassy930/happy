import { Fastify } from "../types";
import { log } from "@/utils/log";
import { auth } from "@/app/auth/auth";
import { verifyLocalToken } from "@/app/auth/localAuth";

const AUTH_MODE = process.env.HAPPY_AUTH_MODE || 'local';

export function enableAuthentication(app: Fastify) {
    app.decorate('authenticate', async function (request: any, reply: any) {
        try {
            const authHeader = request.headers.authorization;
            log({ module: 'auth-decorator' }, `Auth check - mode: ${AUTH_MODE}, path: ${request.url}, has header: ${!!authHeader}`);
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                log({ module: 'auth-decorator' }, `Auth failed - missing or invalid header`);
                return reply.code(401).send({ error: 'Missing authorization header' });
            }

            const token = authHeader.substring(7);
            let verified = null;

            // Try local auth (JWT) first if in local mode
            if (AUTH_MODE === 'local') {
                verified = await verifyLocalToken(token);
                if (verified) {
                    log({ module: 'auth-decorator' }, `Auth success (JWT) - user: ${verified.accountId}, username: ${verified.username}`);
                    request.userId = verified.accountId;
                    return;
                }
            }

            // Fall back to legacy auth (privacy-kit)
            verified = await auth.verifyToken(token);
            if (!verified) {
                log({ module: 'auth-decorator' }, `Auth failed - invalid token (mode: ${AUTH_MODE})`);
                return reply.code(401).send({ error: 'Invalid token' });
            }

            log({ module: 'auth-decorator' }, `Auth success (legacy) - user: ${verified.userId}`);
            request.userId = verified.userId;
        } catch (error) {
            log({ module: 'auth-decorator', level: 'error' }, `Auth error: ${error}`);
            return reply.code(401).send({ error: 'Authentication failed' });
        }
    });
}
