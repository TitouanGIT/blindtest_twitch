import { io } from 'socket.io-client';
export function createSocket(baseUrl) { return io(baseUrl, { transports: ['websocket'] }); }