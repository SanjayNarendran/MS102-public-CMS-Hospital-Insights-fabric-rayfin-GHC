import { date, entity, role, text, uuid } from '@microsoft/rayfin-core';

/** A folder of saved chats in Ask your data; folders nest (parent_id). Each Fabric user sees only their own. */
@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class ChatFolder {
  @uuid() id!: string;
  @text({ max: 200 }) user_id!: string;
  @text({ max: 64, optional: true }) parent_id?: string;
  @text({ min: 1, max: 120 }) name!: string;
  @text({ max: 10 }) kind!: string; // 'user', or 'quick' for the Quick chats folder
  @date() created_at!: Date;
  @date() updated_at!: Date;
}
