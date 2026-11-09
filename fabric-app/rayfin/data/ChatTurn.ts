import { date, entity, int, role, text, uuid } from '@microsoft/rayfin-core';

/** One question in a saved chat; its answer's events are a JSON file in the lakehouse (chatPayload). */
@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class ChatTurn {
  @uuid() id!: string;
  @text({ max: 200 }) user_id!: string;
  @text({ max: 64 }) chat_id!: string;
  @int() idx!: number;
  @text({ min: 1, max: 4000 }) question!: string;
  @text({ max: 300, optional: true }) about?: string;
  @text({ max: 600, optional: true }) preview?: string;
  @text({ max: 20 }) status!: string;
  @int() secs!: number;
  @date() created_at!: Date;
}
