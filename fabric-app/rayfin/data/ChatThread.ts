import { boolean, date, entity, int, role, text, uuid } from '@microsoft/rayfin-core';

/** A saved chat: its title, folder, archive state and the Copilot session that continues it. Answers are in ChatTurn
 *  and, for their events, in the lakehouse (the chatPayload function). */
@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class ChatThread {
  @uuid() id!: string;
  @text({ max: 200 }) user_id!: string;
  @text({ max: 64, optional: true }) folder_id?: string;
  @text({ min: 1, max: 200 }) title!: string;
  @text({ max: 10 }) origin!: string; // 'ask' or 'panel'
  @boolean() archived!: boolean;
  @date({ optional: true }) archived_at?: Date;
  @text({ max: 100, optional: true }) session_id?: string;
  @text({ max: 80, optional: true }) model?: string;
  @int() turns!: number;
  @date() created_at!: Date;
  @date() updated_at!: Date;
}
