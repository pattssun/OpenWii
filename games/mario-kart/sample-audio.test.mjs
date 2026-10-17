import test from 'node:test';
import assert from 'node:assert/strict';
import {SampledKartAudio} from './sample-audio.js';
import {KartAudio} from './audio.js';
function scene(){
 const audio=new SampledKartAudio({ctx:{currentTime:10}}),played=[];
 audio.ready=true;audio.buffers.set('hit-green',{});audio.buffers.set('hit-red',{});audio.buffers.set('shellConfirm',{});
 audio.play=(key,options)=>played.push({key,...options});
 const racers=[0,1].map(id=>({id,x:id*10,y:0,z:0,heading:0,character:{id:'mario'}}));
 const race={racers,player:racers[0]};audio.race=race;
 return {audio,played,race};
}
test('shell hit separates incoming impact, outgoing confirmation and self-hit',()=>{
 for(const [victim,attacker,expected] of [[0,1,['hit-green']],[1,0,['hit-green','shellConfirm']],[0,0,['hit-green']]]){
  const {audio,played,race}=scene();audio.event({type:'hit',racer:victim,attacker,cause:'green'},race);
  assert.deepEqual(played.map(p=>p.key),expected);
 }
});
test('distant owned shell confirms the hit without a nearby crash; other distant hits are silent',()=>{
 const {audio,played,race}=scene();race.racers[1].x=100;
 audio.event({type:'hit',racer:1,attacker:0,cause:'red'},race);
 assert.deepEqual(played.map(p=>p.key),['shellConfirm']);played.length=0;
 audio.event({type:'hit',racer:1,attacker:1,cause:'red'},race);
 assert.deepEqual(played,[]);
});

test('missing shell-specific samples retain the old audible crash for incoming shells',()=>{
 for(const cause of ['green','red','blue']){
  const {audio,played,race}=scene();audio.buffers.clear();
  audio.buffers.set('itemImpact',{});audio.buffers.set('hitConfirm',{});audio.buffers.set('hit',{});
  audio.event({type:'hit',racer:0,attacker:1,cause},race);
  assert.deepEqual(played.map(p=>p.key),['hit']);assert.equal(played[0].gain,1);
 }
});

test('inaudible suspended audio cannot hold the results screen indefinitely',()=>{
 const {audio}=scene();audio.finishCueUntil=20;audio.engine.ctx.state='running';assert.equal(audio.resultsReady,false);
 audio.engine.ctx.state='suspended';assert.equal(audio.resultsReady,true);
 audio.engine.ctx.state='running';audio.engine.ctx.currentTime=20;assert.equal(audio.resultsReady,true);
});


test('results follow the short finish sample, independently of the longer placement fanfare',()=>{
 const {audio,played,race}=scene();
 race.standings=race.racers;
 audio.buffers.set('finish',{duration:1.75});
 audio.buffers.set('finishWin',{duration:7});
 audio.engine.ctx.state='running';
 audio.event({type:'finish',racer:0},race);
 audio.engine.ctx.currentTime=11.749;assert.equal(audio.resultsReady,false);
 audio.engine.ctx.currentTime=11.75;assert.equal(audio.resultsReady,true);
 assert.ok(audio.finishUntil>audio.engine.ctx.currentTime,'Longer fanfare still plays');
 assert.deepEqual(played.map(p=>p.key),['finish','finishWin']);
});

test('multiplayer sample finish waits for the last human before stopping race audio',()=>{
 for(const humanCount of [2,4]){
  const {audio,played,race}=scene(),music={key:'race'},ended=[];
  race.humanCount=humanCount;race.state='racing';race.standings=race.racers;
  while(race.racers.length<humanCount)race.racers.push({id:race.racers.length,character:{id:'mario'}});
  audio.buffers.set('finish',{duration:1.75});audio.buffers.set('finishWin',{duration:7});
  audio.nodes.add(music);audio.loops.set('music',music);
  audio.end=node=>ended.push(node);
  audio.event({type:'finish',racer:0},race);
  assert.deepEqual(played,[]);
  assert.equal(audio.finishAt,0);
  assert.equal(audio.loops.get('music'),music);
  assert.deepEqual(ended,[]);
  race.state='finishing';
  audio.event({type:'finish',racer:humanCount-1},race);
  assert.deepEqual(played.map(cue=>cue.key),['finish','finishWin']);
  assert.equal(audio.finishAt,10);
  assert.equal(audio.loops.size,0);
  assert.deepEqual(ended,[music]);
 }
});

test('synth fallback defers the shared finish cue for two and four humans',()=>{
 for(const humanCount of [2,4]){
  const audio=new KartAudio(),played=[];
  audio.original.event=()=>false;
  audio.engine.ctx={currentTime:10};
  audio.engine.play=(key,event)=>played.push({key,racer:event.racer});
  const race={humanCount,state:'racing'};
  audio.event({type:'finish',racer:0},race);
  assert.deepEqual(played,[]);
  assert.equal(audio.fallbackFinishUntil,undefined);
  race.state='finishing';
  audio.event({type:'finish',racer:humanCount-1},race);
  assert.deepEqual(played,[{key:'mk-finish',racer:0}]);
  assert.equal(audio.fallbackFinishUntil,10.6);
 }
});

test('same-step multiplayer finishes play one sampled cue per race',()=>{
 for(const humanCount of [2,4]){
  const {audio,played,race}=scene(),music={key:'race'},ended=[];
  race.humanCount=humanCount;race.state='finishing';
  while(race.racers.length<humanCount)race.racers.push({id:race.racers.length,character:{id:'mario'}});
  race.standings=race.racers;
  audio.buffers.set('finish',{duration:1.75});audio.buffers.set('finishWin',{duration:7});
  audio.nodes.add(music);audio.loops.set('music',music);audio.end=node=>ended.push(node);
  for(let racer=0;racer<humanCount;racer++)audio.event({type:'finish',racer},race);
  assert.deepEqual(played.map(cue=>cue.key),['finish','finishWin']);
  assert.deepEqual(ended,[music]);
  const nextRace={...race};
  audio.event({type:'finish',racer:humanCount-1},nextRace);
  assert.deepEqual(played.map(cue=>cue.key),['finish','finishWin','finish','finishWin']);
 }
});

test('same-step multiplayer finishes play one synth cue per race',()=>{
 for(const humanCount of [2,4]){
  const audio=new KartAudio(),played=[];
  audio.original.event=()=>false;
  audio.engine.ctx={currentTime:10};
  audio.engine.play=(key,event)=>played.push({key,racer:event.racer});
  const race={humanCount,state:'finishing'};
  for(let racer=0;racer<humanCount;racer++)audio.event({type:'finish',racer},race);
  assert.deepEqual(played,[{key:'mk-finish',racer:0}]);
  audio.event({type:'finish',racer:humanCount-1},{...race});
  assert.deepEqual(played,[{key:'mk-finish',racer:0},{key:'mk-finish',racer:0}]);
 }
});
