import { ChatFolder } from './ChatFolder.js';
import { ChatThread } from './ChatThread.js';
import { ChatTurn } from './ChatTurn.js';

/** Ask your data's saved chats, per Fabric user (assets/js/chat/history.js, src/rayfin-bridge.js). */
export type ChatSchema = {
  ChatFolder: ChatFolder;
  ChatThread: ChatThread;
  ChatTurn: ChatTurn;
};

export const schema = [ChatFolder, ChatThread, ChatTurn];
