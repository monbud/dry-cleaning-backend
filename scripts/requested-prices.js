// Amounts supplied by the business owner, in naira. Database amounts use kobo.
const garments = [
  ['JEANS', 400, 300], ['DUVET', 3000, 2000], ['BEDSPREAD', 1000, 500],
  ['PILLOWCASE', 300, 200], ['LIGHT GOWNS', 300, 200], ['THICK GOWNS', 500, 350],
  ['LIGHT SKIRTS', 300, 200], ['THICK SKIRTS', 500, 350], ['SHIRTS', 300, 200],
  ['THICK SHIRTS', 500, 350], ['TROUSERS', 300, 200], ['THICK TROUSERS', 500, 350],
  ['CURTAINS', 1500, 800], ['SUIT COAT', 1000, 500], ['WEDDING GOWNS', 1500, 800],
  ['UNDERWEARS', 400, 300], ['LIGHT or SMALL TOWELS', 300, 200], ['THICK or LARGE TOWELS', 500, 350],
];
const washOnly = [['SLIPPERS', 300], ['SHOES', 500], ['Small Hand Bags', 500], ['Mid-Size School Bags', 1000], ['Large Size Bags or Boxes', 3000]];
export function requestedPrices(combined) {
  if (!['sum', 'unset'].includes(combined)) throw new Error('Choose --combined=sum or --combined=unset.');
  return [...garments.map(([category, wash, iron]) => ({ category, wash: wash * 100, iron: iron * 100, washIron: combined === 'sum' ? (wash + iron) * 100 : null })), ...washOnly.map(([category, wash]) => ({ category, wash: wash * 100, iron: null, washIron: null }))];
}
