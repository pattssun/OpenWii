/** Vector lettering redrawn against native race overlays. No installed font is
 * required; these are approximations of the game's bespoke display glyphs. */
const glyphs={
 '1':['M9 18 30 2H47V78H26V28L9 35Z',48],
 '2':['M3 18 18 2H48L62 16V34L25 60H61V78H2V57L41 28V20H24L15 30Z',64],
 '3':['M3 2H48L62 16V31L51 39 62 48V63L48 78H2V59H39L43 54V48H21V31H40L43 27V21H3Z',64],
 '4':['M31 2H54V47H64V65H54V78H33V65H1V46ZM33 24 18 47H33Z',66],
 '5':['M6 2H60V22H26V31H47L62 44V63L47 78H3V58H39L43 54V50L39 46H4Z',64],
 '6':['M17 2H59V21H27L23 26V33H48L62 45V63L48 78H16L2 64V18ZM23 50V58L27 62H37L41 58V50Z',64],
 '7':['M2 2H62V22L31 78H7L39 23H2Z',64],
 '8':['M17 2H47L61 16V31L51 39 63 49V63L48 78H16L1 64V49L12 39 3 31V16ZM24 19V30H40V19ZM23 48V61H41V48Z',65],
 'G':['M3 25 20 6 47 0 71 10 61 29 45 22 28 32 26 55 43 58 46 48H35V32H72V68L37 80 7 70Z',76],
 'O':['M4 22 28 2 53 6 69 25 63 61 38 78 10 67 0 48ZM26 31 23 47 36 52 46 43 44 29 35 26Z',72],
 'F':['M5 2H62V22H27V34H55V54H27V78H5Z',63],
 'I':['M6 2H29V78H6Z',34],
 'N':['M4 2H26L48 41V2H69V78H47L25 40V78H4Z',74],
 'S':['M17 2H61V23H28L24 27 57 41 65 53V65L51 78H3V56H39L42 52 12 40 2 28V16Z',68],
 'H':['M4 2H26V29H48V2H70V78H48V51H26V78H4Z',75],
 '!':['M8 2H31L26 53H8ZM6 60H27V79H4Z',34],
};
const colors={gold:['#fff577','#f9d334','#eca02c'],silver:['#ffffff','#e4f2f6','#a9c4d2'],bronze:['#fff1d2','#efc890','#bb895e'],orange:['#ffe073','#f4ba39','#dc8221']};
let serial=0;
/** Use the same rank artwork and medal palette in every race viewport. */
export function racePosition(element, position) {
 if(element.dataset.rank===String(position))return false;
 element.dataset.rank=String(position);
 const suffix=position===1?'st':position===2?'nd':position===3?'rd':'th';
 element.setAttribute('aria-label',`${position}${suffix}`);
 element.innerHTML=raceLettering(String(position),position===1?'gold':position===2?'silver':position===3?'bronze':'orange')+`<sup>${suffix}</sup>`;
 return true;
}
export function raceLettering(text,palette='gold'){
 const id='race-ink-'+serial++,c=colors[palette]||colors.gold;let x=12,paths='';
 let index=0;
 for(const char of text){const g=glyphs[char];if(!g){x+=20;continue;}paths+=`<path transform="translate(${x} 5) rotate(${text==='FINISH!'?[-3,5,-3,2,-4,-2,3][index++]:0} ${g[1]/2} 40)" d="${g[0]}"/>`;x+=g[1]+2;}
 return `<svg class="race-lettering" viewBox="0 0 ${x+16} 94" role="img" aria-label="${text}"><defs><linearGradient id="${id}" x2="0" y2="1"><stop stop-color="${c[0]}"/><stop offset=".48" stop-color="${c[1]}"/><stop offset="1" stop-color="${c[2]}"/></linearGradient><pattern id="${id}-checks" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M0 0H5V5H0ZM5 5H10V10H5Z" fill="#fff" opacity=".09"/></pattern></defs><g transform="translate(11 0) skewX(-8)" fill-rule="evenodd" stroke-linejoin="round"><g transform="translate(1 3)" fill="#2d2923" stroke="#2d2923" stroke-width="7">${paths}</g><g fill="url(#${id})" stroke="#fffce9" stroke-width="4" paint-order="stroke">${paths}</g><g fill="url(#${id}-checks)">${paths}</g></g></svg>`;
}

export function lapBoard(lap,total=3){
 const digits=['01110/10001/10011/10101/11001/10001/01110','00100/01100/00100/00100/00100/00100/01110','01110/10001/00001/00110/01000/10000/11111','11110/00001/00001/01110/00001/00001/11110','00010/00110/01010/10010/11111/00010/00010','11111/10000/10000/11110/00001/00001/11110','01110/10000/10000/11110/10001/10001/01110','11111/00001/00010/00100/01000/01000/01000','01110/10001/10001/01110/10001/10001/01110','01110/10001/10001/01111/00001/00001/01110'];
 const dots=(n,x,y,scale,color)=>String(n).split('').map((digit,k)=>digits[Number(digit)].split('/').map((row,j)=>[...row].map((b,i)=>b==='1'?`<circle cx="${x+(k*6+i)*scale}" cy="${y+j*scale}" r="${scale*.39}" fill="${color}"/>`:'').join('')).join('')).join('');
 return `<svg viewBox="0 0 150 128" role="img" aria-label="Lap ${lap} of ${total}"><defs><linearGradient id="lap-metal" x2="1" y2="1"><stop stop-color="#89877b"/><stop offset=".4" stop-color="#dad7b3"/><stop offset="1" stop-color="#514f42"/></linearGradient></defs><path d="M12 8H138V120H12Z" fill="url(#lap-metal)" stroke="#34382d" stroke-width="4"/><path d="M20 16H130V112H20Z" fill="#26291b" stroke="#64644a" stroke-width="3"/>${dots(lap,lap>=10?30:38,30,lap>=10?5:8,'#ffdd34')}${dots(total,total>=10?91:98,68,total>=10?3.5:5,'#f9f3d5')}<path d="M78 93 96 65" stroke="#fff5cd" stroke-width="5"/></svg>`;
}
