import axios from 'axios';
import { getServerUrl } from "@/sync/serverConfig";

export interface LocalAuthResult {
    success: boolean;
    token: string;
    userId: string;
    username: string;
}

export async function localLogin(username: string, password: string): Promise<LocalAuthResult> {
    const serverUrl = getServerUrl();
    const response = await axios.post(`${serverUrl}/v1/auth/login`, { username, password });
    return response.data;
}

export async function localRegister(username: string, password: string): Promise<LocalAuthResult> {
    const serverUrl = getServerUrl();
    const response = await axios.post(`${serverUrl}/v1/auth/register`, { username, password });
    return response.data;
}
