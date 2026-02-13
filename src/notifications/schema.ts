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
      type: 'string',
    },
    reasonCode: {
      type: 'string',
    },
  },
  required: ['delivery'],
  additionalProperties: false,
} as const;

const notificationDecisionSchema = z
  .object({
    delivery: z.enum(['send', 'suppress']),
    message: z.string().optional(),
    reasonCode: z.string().optional(),
  })
  .strict();

export function parseNotificationDecision(raw: string): NotificationDecision | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = notificationDecisionSchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
}
