import { z } from 'zod';

export const CreateChannelSchema = z.object({
  acronym: z.string().min(1).max(16).optional(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  inviteLink: z.string().url().optional(),
  whatsappId: z.string().optional(),
});

export const UpdateChannelSchema = CreateChannelSchema.partial();

export const ChannelSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string(),
  acronym: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  inviteLink: z.string().nullable(),
  whatsappId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
});

export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;
export type UpdateChannelInput = z.infer<typeof UpdateChannelSchema>;
export type Channel = z.infer<typeof ChannelSchema>;
