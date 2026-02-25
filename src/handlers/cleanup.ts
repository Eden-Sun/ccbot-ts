/**
 * Unified cleanup API for topic state.
 *
 * Coordinates cleanup across all modules when a topic is closed or becomes stale.
 */

import type { Bot } from "grammy"
import { clearInteractiveMsg } from "./interactiveUI"
import { clearStatusMsgInfo, clearToolMsgIdsForTopic } from "./messageQueue"

export async function clearTopicState(
  userId: number,
  threadId: number,
  bot: Bot | null = null,
): Promise<void> {
  clearStatusMsgInfo(userId, threadId)
  clearToolMsgIdsForTopic(userId, threadId)
  await clearInteractiveMsg(userId, bot, threadId, true) // force: explicit topic teardown
}
