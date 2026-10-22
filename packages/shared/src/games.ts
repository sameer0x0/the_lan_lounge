export type GameId = 'dare' | 'uno' | 'imposter';

export interface GameInfo {
  id: GameId;
  name: string;
  blurb: string;
  /** Disabled games are shown greyed out and cannot be started. */
  enabled: boolean;
}

export const GAMES: readonly GameInfo[] = [
  { id: 'imposter', name: 'Imposter', blurb: 'A few of you are imposters. Vote them out.', enabled: true },
  { id: 'uno', name: 'UNO', blurb: 'Classic UNO, your hand stays on your phone.', enabled: true },
  { id: 'dare', name: 'Dare or Dare', blurb: 'Host-written dares, random victims.', enabled: false },
];
