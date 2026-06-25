import * as z from "zod";

export const ListenStarted = z.object({
  message_type: z.literal("listen-started"),
  other_listeners: z.number().int(),
});
export type ListenStarted = z.infer<typeof ListenStarted>;

/**
 * @description Sent from the server when it wants to start a call and has assigned it to the appropriate pod.
 */
export const InitiateAndAssignCall = z.object({
  message_type: z.literal("initiate-and-assign-call"),
  call_id: z.string(),
  contact_data: z.unknown(),
});
export type InitiateAndAssignCall = z.infer<typeof InitiateAndAssignCall>;

/**
 * @description Sent from the client when it has initiated a call controller and is ready to connect to the call.
 */
export const ControllerReady = z.object({
  message_type: z.literal("controller-ready"),
  call_id: z.string(),
});
export type ControllerReady = z.infer<typeof ControllerReady>;

/**
 * @description Sent from the client when the controller failed to initialize (e.g. timeout). The server should release any resources held for this call.
 */
export const InitControllerFailed = z.object({
  message_type: z.literal("init-controller-failed"),
  call_id: z.string(),
});
export type InitControllerFailed = z.infer<typeof InitControllerFailed>;

export const ServerMessage = z.discriminatedUnion("message_type", [
  ListenStarted,
  InitiateAndAssignCall,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export const ClientMessage = z.discriminatedUnion("message_type", [
  ControllerReady,
  InitControllerFailed,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export function decodeServerMessage(payload: Record<string, unknown>): ServerMessage {
  return ServerMessage.parse(payload);
}
