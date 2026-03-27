import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { db } from '@/storage/db';
import { log } from '@/utils/log';

const SALT_ROUNDS = 10;
const JWT_EXPIRY = '7d';

export interface LocalUserCreate {
    username: string;
    password: string;
}

export interface LocalAuthResult {
    accountId: string;
    username: string;
    token: string;
}

/**
 * Register a new local user with username and password.
 * Creates both an Account and LocalUser record.
 */
export async function registerLocalUser(input: LocalUserCreate): Promise<LocalAuthResult> {
    const { username, password } = input;

    log({ module: 'local-auth' }, `Registering new user: ${username}`);

    // Check if username exists
    const existing = await db.localUser.findUnique({ where: { username } });
    if (existing) {
        log({ module: 'local-auth', level: 'error' }, `Username already exists: ${username}`);
        throw new Error('Username already exists');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // Create account and local user in transaction
    const result = await db.$transaction(async (tx) => {
        // Create account with placeholder publicKey
        const account = await tx.account.create({
            data: {
                publicKey: `local:${username}`,
                seq: 0,
                feedSeq: BigInt(0),
            },
        });

        // Create local user
        const localUser = await tx.localUser.create({
            data: {
                username,
                passwordHash,
                accountId: account.id,
            },
        });

        return { account, localUser };
    });

    // Generate JWT
    const secret = process.env.JWT_SECRET || 'change-this-secret';
    const token = jwt.sign(
        {
            sub: result.account.id,
            username: result.localUser.username,
        },
        secret,
        { expiresIn: JWT_EXPIRY }
    );

    log({ module: 'local-auth' }, `User registered successfully: ${username}`);

    return {
        accountId: result.account.id,
        username: result.localUser.username,
        token,
    };
}

/**
 * Login a local user with username and password.
 * Returns a JWT token on success.
 */
export async function loginLocalUser(username: string, password: string): Promise<LocalAuthResult> {
    log({ module: 'local-auth' }, `Login attempt for user: ${username}`);

    // Find user
    const localUser = await db.localUser.findUnique({
        where: { username },
        include: { account: true },
    });

    if (!localUser) {
        log({ module: 'local-auth', level: 'error' }, `User not found: ${username}`);
        throw new Error('Invalid username or password');
    }

    // Verify password
    const isValid = await bcrypt.compare(password, localUser.passwordHash);
    if (!isValid) {
        log({ module: 'local-auth', level: 'error' }, `Invalid password for user: ${username}`);
        throw new Error('Invalid username or password');
    }

    // Generate JWT
    const secret = process.env.JWT_SECRET || 'change-this-secret';
    const token = jwt.sign(
        {
            sub: localUser.accountId,
            username: localUser.username,
        },
        secret,
        { expiresIn: JWT_EXPIRY }
    );

    log({ module: 'local-auth' }, `User logged in successfully: ${username}`);

    return {
        accountId: localUser.accountId,
        username: localUser.username,
        token,
    };
}

/**
 * Verify a JWT token and return the user info.
 */
export async function verifyLocalToken(
    token: string
): Promise<{ accountId: string; username: string } | null> {
    try {
        const secret = process.env.JWT_SECRET || 'change-this-secret';
        const decoded = jwt.verify(token, secret) as {
            sub: string;
            username: string;
        };
        return {
            accountId: decoded.sub,
            username: decoded.username,
        };
    } catch (error) {
        log({ module: 'local-auth', level: 'error' }, `Token verification failed: ${error}`);
        return null;
    }
}

/**
 * Get local user info by accountId.
 */
export async function getLocalUserByAccountId(
    accountId: string
): Promise<{ username: string } | null> {
    const localUser = await db.localUser.findUnique({
        where: { accountId },
        select: { username: true },
    });
    return localUser ? { username: localUser.username } : null;
}
