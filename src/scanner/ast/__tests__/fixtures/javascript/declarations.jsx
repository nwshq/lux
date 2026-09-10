import React from 'react';
export function Card() {
  return <section onClick={() => helper()}>card</section>;
}
const helper = () => React.createElement('span');
export default Card;
