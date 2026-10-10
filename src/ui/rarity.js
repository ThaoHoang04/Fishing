// Display info per rarity (order and odds live in systems/FishingRules.js).
export const RARITY_STYLE = {
  common: { label: 'Common', color: '#c8d0d8', hex: 0xc8d0d8 },
  rare: { label: 'Rare', color: '#4aa8ff', hex: 0x4aa8ff },
  epic: { label: 'Epic', color: '#c77dff', hex: 0xc77dff },
  legendary: { label: 'Legendary', color: '#ffb703', hex: 0xffb703 },
};

export const formatWeight = (kg) => `${kg.toFixed(2)} kg`;
