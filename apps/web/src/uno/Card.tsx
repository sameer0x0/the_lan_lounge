import { CARD_BACK, cardAsset, type UnoCard, type UnoColor } from '@party/shared';

export const COLOR_HEX: Record<UnoColor, string> = {
  red: '#D32F2F',
  yellow: '#FBC02D',
  green: '#2E7D32',
  blue: '#1565C0',
};

/** Spoken/alt name of a card, e.g. "red 5", "blue Skip", "Wild Draw Four". */
export function cardName(card: Pick<UnoCard, 'color' | 'kind' | 'value'>): string {
  switch (card.kind) {
    case 'number':
      return `${card.color} ${card.value}`;
    case 'skip':
      return `${card.color} Skip`;
    case 'reverse':
      return `${card.color} Reverse`;
    case 'draw2':
      return `${card.color} Draw Two`;
    case 'wild':
      return 'Wild';
    case 'wild4':
      return 'Wild Draw Four';
  }
}

interface CardProps {
  card: UnoCard;
  /** Pixel width; height follows the 2:3 card shape. */
  width: number;
  playable?: boolean;
  dimmed?: boolean;
  onClick?: () => void;
}

/** A card face as an image. Playable cards lift and glow; the rest dim. */
export function Card({ card, width, playable, dimmed, onClick }: CardProps) {
  const img = (
    <img
      src={cardAsset(card)}
      alt={cardName(card)}
      width={width}
      height={Math.round(width * 1.5)}
      draggable={false}
      className={`block select-none rounded-xl transition-transform duration-150 ${
        playable ? '-translate-y-4 shadow-[0_0_0_4px_#34d399,0_8px_20px_rgba(0,0,0,0.6)]' : 'shadow-md'
      } ${dimmed ? 'opacity-45' : ''}`}
    />
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="shrink-0 touch-manipulation focus:outline-none" aria-label={`Play ${cardName(card)}`}>
      {img}
    </button>
  ) : (
    <div className="shrink-0">{img}</div>
  );
}

export function CardBack({ width, className = '' }: { width: number; className?: string }) {
  return (
    <img src={CARD_BACK} alt="Draw pile" width={width} height={Math.round(width * 1.5)} draggable={false} className={`block select-none rounded-xl shadow-md ${className}`} />
  );
}
