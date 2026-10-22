import type { UnoEvent } from '@party/shared';
import { cardName } from './Card';

/** One human line per engine event, e.g. "Nadia played blue Draw Two". `who` maps a player id to a name. */
export function describeEvent(e: UnoEvent, who: (id: string) => string): string {
  switch (e.kind) {
    case 'play':
      return `${who(e.playerId)} played ${cardName(e.card)}${e.card.color === 'wild' && e.color ? ` (${e.color})` : ''}`;
    case 'draw':
      if (e.reason === 'skipped') return `${who(e.playerId)} was skipped`;
      if (e.reason === 'turn') return `${who(e.playerId)} drew a card`;
      return `${who(e.playerId)} drew ${e.count}`;
    case 'pass':
      return `${who(e.playerId)} passed`;
    case 'skip':
      return `${who(e.playerId)} was skipped`;
    case 'reverse':
      return 'Direction reversed';
    case 'challenge':
      return e.bluffing
        ? `${who(e.challengerId)} caught ${who(e.targetId)} bluffing!`
        : `${who(e.challengerId)} challenged wrongly`;
    case 'uno':
      return `${who(e.playerId)} called UNO!`;
    case 'catch':
      return `${who(e.catcherId)} caught ${who(e.targetId)}!`;
    case 'reshuffle':
      return 'Discard pile reshuffled';
    case 'round':
      return `${who(e.winnerId)} won the round (+${e.points})`;
  }
}
