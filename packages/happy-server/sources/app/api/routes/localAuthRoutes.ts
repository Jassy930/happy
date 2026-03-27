import { z } from "zod";
import { type Fastify } from "../types";
import { registerLocalUser, loginLocalUser, getLocalUserByAccountId } from "@/app/auth/localAuth";
import { log } from "@/utils/log";

export function localAuthRoutes(app: Fastify) {
    // POST /v1/auth/register - User registration
    app.post('/v1/auth/register', {
        schema: {
            body: z.object({
                username: z.string().min(3).max(64),
                password: z.string().min(6),
            }),
            response: {
                200: z.object({
                    success: z.literal(true),
                    userId: z.string(),
                    username: z.string(),
                    token: z.string(),
                }),
                409: z.object({
                    error: z.string(),
                }),
                400: z.object({
                    error: z.string(),
                }),
            },
        },
    }, async (request, reply) => {
        try {
            const result = await registerLocalUser(request.body);
            return reply.send({
                success: true,
                userId: result.accountId,
                username: result.username,
                token: result.token,
            });
        } catch (err) {
            if (err instanceof Error) {
                if (err.message === 'Username already exists') {
                    return reply.code(409).send({ error: err.message });
                }
                return reply.code(400).send({ error: err.message });
            }
            throw err;
        }
    });

    // POST /v1/auth/login - User login
    app.post('/v1/auth/login', {
        schema: {
            body: z.object({
                username: z.string(),
                password: z.string(),
            }),
            response: {
                200: z.object({
                    success: z.literal(true),
                    userId: z.string(),
                    username: z.string(),
                    token: z.string(),
                }),
                401: z.object({
                    error: z.string(),
                }),
            },
        },
    }, async (request, reply) => {
        try {
            const result = await loginLocalUser(request.body.username, request.body.password);
            return reply.send({
                success: true,
                userId: result.accountId,
                username: result.username,
                token: result.token,
            });
        } catch (err) {
            if (err instanceof Error && err.message === 'Invalid username or password') {
                return reply.code(401).send({ error: err.message });
            }
            throw err;
        }
    });

    // GET /v1/auth/me - Get current user info (requires authentication)
    app.get('/v1/auth/me', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    userId: z.string(),
                    username: z.string(),
                }),
                404: z.object({
                    error: z.string(),
                }),
            },
        },
    }, async (request, reply) => {
        const userId = (request as any).userId;
        const localUser = await getLocalUserByAccountId(userId);

        if (!localUser) {
            return reply.code(404).send({ error: 'Local user not found' });
        }

        return reply.send({
            userId,
            username: localUser.username,
        });
    });
}
