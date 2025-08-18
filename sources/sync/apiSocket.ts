import { io, Socket } from 'socket.io-client';
import { TokenStorage } from '@/auth/tokenStorage';
import { ApiEncryption } from './apiEncryption';

//
// Types
//

export interface SyncSocketConfig {
    endpoint: string;
    token: string;
}

export interface SyncSocketState {
    isConnected: boolean;
    connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    lastError: Error | null;
}

export type SyncSocketListener = (state: SyncSocketState) => void;

//
// Main Class
//

class ApiSocket {

    // State
    private socket: Socket | null = null;
    private config: SyncSocketConfig | null = null;
    private encryption: ApiEncryption | null = null;
    private messageHandlers: Map<string, (data: any) => void> = new Map();
    private reconnectedListeners: Set<() => void> = new Set();
    private statusListeners: Set<(status: 'disconnected' | 'connecting' | 'connected' | 'error') => void> = new Set();
    private currentStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';

    //
    // Initialization
    //

    initialize(config: SyncSocketConfig, encryption: ApiEncryption) {
        this.config = config;
        this.encryption = encryption;
        this.connect();
    }

    //
    // Connection Management
    //

    connect() {
        if (!this.config || this.socket) {
            return;
        }

        this.updateStatus('connecting');

        this.socket = io(this.config.endpoint, {
            path: '/v1/updates',
            auth: {
                token: this.config.token,
                clientType: 'user-scoped' as const
            },
            transports: ['websocket'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity
        });

        this.setupEventHandlers();
    }

    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
        this.updateStatus('disconnected');
    }

    //
    // Listener Management
    //

    onReconnected = (listener: () => void) => {
        this.reconnectedListeners.add(listener);
        return () => this.reconnectedListeners.delete(listener);
    };

    onStatusChange = (listener: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void) => {
        this.statusListeners.add(listener);
        // Immediately notify with current status
        listener(this.currentStatus);
        return () => this.statusListeners.delete(listener);
    };

    //
    // Message Handling
    //

    onMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.set(event, handler);
        return () => this.messageHandlers.delete(event);
    }

    offMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.delete(event);
    }

    async rpc<R, A>(sessionId: string, method: string, params: A): Promise<R> {
        const result = await this.socket!.emitWithAck('rpc-call', {
            method: `${sessionId}:${method}`,
            params: this.encryption!.encryptRaw(params)
        });
        if (result.ok) {
            return this.encryption?.decryptRaw(result.result) as R;
        }
        throw new Error('RPC call failed');
    }
    
    async daemonRpc<R = any, A = any>(machineId: string, method: string, params: A): Promise<R> {
        if (!this.socket) {
            throw new Error('Socket not connected');
        }
        
        if (!this.encryption) {
            throw new Error('Encryption not initialized');
        }
        
        console.log(`🔌 DaemonRPC: Calling ${machineId}:${method}`, params);
        
        try {
            // For daemon RPCs, we prefix with machineId and encrypt params (SECURITY REQUIREMENT)
            // Set timeout to 15 seconds for daemon operations like session spawning
            const result = await this.socket.timeout(15000).emitWithAck('rpc-call', {
                method: `${machineId}:${method}`,
                params: this.encryption.encryptRaw(params)
            });
            
            console.log(`🔌 DaemonRPC: Response for ${machineId}:${method}`, result);
            
            if (result.ok) {
                return this.encryption.decryptRaw(result.result) as R;
            }
            throw new Error(result.error || 'Daemon RPC call failed');
        } catch (error) {
            console.error(`🔌 DaemonRPC: Error for ${machineId}:${method}`, error);
            throw error;
        }
    }

    send(event: string, data: any) {
        this.socket!.emit(event, data);
        return true;
    }

    //
    // Machine Metadata Update (FUTURE USE - NOT TESTED)
    //

    /**
     * Update machine metadata with optimistic concurrency control
     * NOTE: This is for future use and has not been tested yet
     * 
     * @param machineId - The ID of the machine to update
     * @param metadata - The encrypted metadata string
     * @param expectedVersion - The expected version number for optimistic concurrency
     * @returns Promise with result status and new version if successful
     */
    async updateMachineMetadata(params: {
        machineId: string;
        metadata: string;
        expectedVersion: number;
    }): Promise<{
        result: 'success' | 'error' | 'version-mismatch';
        version?: number;
        metadata?: string;
        message?: string;
    }> {
        if (!this.socket || !this.socket.connected) {
            throw new Error('Socket not connected');
        }

        return this.socket.timeout(10000).emitWithAck('machine-update-metadata', params);
    }

    //
    // HTTP Requests
    //

    async request(path: string, options?: RequestInit): Promise<Response> {
        if (!this.config) {
            throw new Error('SyncSocket not initialized');
        }

        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            throw new Error('No authentication credentials');
        }

        const url = `${this.config.endpoint}${path}`;
        const headers = {
            'Authorization': `Bearer ${credentials.token}`,
            ...options?.headers
        };

        return fetch(url, {
            ...options,
            headers
        });
    }

    //
    // Token Management
    //

    updateToken(newToken: string) {
        if (this.config && this.config.token !== newToken) {
            this.config.token = newToken;

            if (this.socket) {
                this.disconnect();
                this.connect();
            }
        }
    }

    //
    // Private Methods
    //

    private updateStatus(status: 'disconnected' | 'connecting' | 'connected' | 'error') {
        if (this.currentStatus !== status) {
            this.currentStatus = status;
            this.statusListeners.forEach(listener => listener(status));
        }
    }

    private setupEventHandlers() {
        if (!this.socket) return;

        // Connection events
        this.socket.on('connect', () => {
            // console.log('🔌 SyncSocket: Connected, recovered: ' + this.socket?.recovered);
            // console.log('🔌 SyncSocket: Socket ID:', this.socket?.id);
            this.updateStatus('connected');
            if (!this.socket?.recovered) {
                this.reconnectedListeners.forEach(listener => listener());
            }
        });

        this.socket.on('disconnect', (reason) => {
            // console.log('🔌 SyncSocket: Disconnected', reason);
            this.updateStatus('disconnected');
        });

        // Error events
        this.socket.on('connect_error', (error) => {
            // console.error('🔌 SyncSocket: Connection error', error);
            this.updateStatus('error');
        });

        this.socket.on('error', (error) => {
            // console.error('🔌 SyncSocket: Error', error);
            this.updateStatus('error');
        });

        // Authentication response
        this.socket.on('auth', (data) => {
            // console.log('🔌 SyncSocket: Auth response:', data);
        });

        // Message handling
        this.socket.onAny((event, data) => {
            // console.log(`📥 SyncSocket: Received event '${event}':`, JSON.stringify(data).substring(0, 200));
            const handler = this.messageHandlers.get(event);
            if (handler) {
                // console.log(`📥 SyncSocket: Calling handler for '${event}'`);
                handler(data);
            } else {
                // console.log(`📥 SyncSocket: No handler registered for '${event}'`);
            }
        });
    }
}

//
// Singleton Export
//

export const apiSocket = new ApiSocket();