const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export function createBoostFeedback(){
 let was=false,onset=-100,strength=0,last=-1;
 return (time,boost)=>{
  if(time<last){was=false;onset=-100;strength=0;}
  const dt=last<0?0:clamp(time-last,0,.1);last=time;
  const active=boost>0;if(active&&!was)onset=time;was=active;
  strength+=(Number(active)-strength)*(1-Math.exp(-dt*(active?22:9)));
  return {strength,kick:active?Math.exp(-(time-onset)*7):0};
 };
}
/** Race-clock animation: a short rush outward at activation, then continuous
 * peripheral streaks; the middle stays clear for items and the road. */
export function boostScreen(element){
 const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 1440 900');svg.setAttribute('preserveAspectRatio','none');
 const rays=Array.from({length:22},(_,i)=>{const line=document.createElementNS(ns,'line');line.setAttribute('stroke','white');line.setAttribute('stroke-width',i%4===0?'2.3':'1.1');line.setAttribute('stroke-linecap','round');svg.append(line);return line;});element.replaceChildren(svg);
 const updateFeedback=createBoostFeedback();
 return (time,boost)=>{
  const feedback=updateFeedback(time,boost);
  element.style.opacity=String(feedback.strength*.6);
  for(let i=0;i<rays.length;i++){const a=i*2.3999632,p=(time*(2.5+i%3*.25)+i*.618)%1,r=.66+p*.55,len=.06+p*.2,x=Math.cos(a)*880,y=Math.sin(a)*590,line=rays[i];line.setAttribute('x1',720+x*r);line.setAttribute('y1',470+y*r);line.setAttribute('x2',720+x*(r+len));line.setAttribute('y2',470+y*(r+len));line.setAttribute('opacity',String(Math.sin(p*Math.PI)*.7));}
  return feedback;
 };
}
