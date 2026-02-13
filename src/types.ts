export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcIncoming =
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse
  | JsonRpcRequest
  | JsonRpcNotification;

export interface SendblueMessage {
  message_handle: string;
  content: string;
  from_number: string;
  to_number: string;
  number?: string;
  status?: string;
  date_sent?: string;
  date_updated?: string;
  created_at?: string;
  is_outbound: boolean;
  media_url?: string;
}

export interface SendblueListResponse {
  status?: string;
  data?: SendblueMessage[];
  pagination?: {
    total?: number;
    page?: number;
    page_size?: number;
  };
}

export interface SendblueSendResponse {
  message_handle?: string;
  id?: string;
}

export interface SessionState {
  phoneNumber: string;
  threadId: string | null;
  activeTurnId: string | null;
  model: string;
  updatedAtMs: number;
}

export type AuditKind =
  | 'inbound_message'
  | 'outbound_message'
  | 'command'
  | 'turn_started'
  | 'turn_completed'
  | 'turn_steered'
  | 'turn_interrupted'
  | 'agent_delta'
  | 'approval_request'
  | 'approval_response'
  | 'notification_ingested'
  | 'notification_duplicate'
  | 'notification_queued'
  | 'notification_processing'
  | 'notification_sent'
  | 'notification_suppressed'
  | 'notification_failed'
  | 'error'
  | 'system';

export interface AuditEvent {
  id: number;
  tsMs: number;
  phoneNumber: string | null;
  threadId: string | null;
  turnId: string | null;
  kind: AuditKind;
  summary: string;
  payload: unknown;
}

export interface BridgeFlags {
  paused: boolean;
  autoApprove: boolean;
}

export interface InputText {
  type: 'text';
  text: string;
  text_elements: [];
}
