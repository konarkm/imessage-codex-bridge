import { z } from 'zod';
import type { NotificationDecision } from './types.js';

export const notificationDecisionOutputSchema = {
  type: 'object',
  properties: {
    delivery: {
      type: 'string',
      enum: ['send', 'suppress'],
    },
    message: {
      type: ['string', 'null'],
    },
    reasonCode: {
      type: ['string', 'null'],
    },
  },
  required: ['delivery', 'message', 'reasonCode'],
  additionalProperties: false,
} as const;

const notificationDecisionSchema = z
  .object({
    delivery: z.enum(['send', 'suppress']),
    message: z.string().nullable().optional(),
    reasonCode: z.string().nullable().optional(),
  })
  .strict();

export function parseNotificationDecision(raw: string): NotificationDecision | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = notificationDecisionSchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }
    return {
      delivery: result.data.delivery,
      message: result.data.message ?? undefined,
      reasonCode: result.data.reasonCode ?? undefined,
    };
  } catch {
    return null;
  }
}
