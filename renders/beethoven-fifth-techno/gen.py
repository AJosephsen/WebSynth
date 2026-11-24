import json
J=json.load(open('s5.json'));div=J['div'];BAR=2*div;STEP=div//4  # 96 ticks = a 16th
tr={i:[e for e in ev if e[0]=='n'] for i,(nm,ev) in enumerate(J['tracks'])}
last=max(e[1]+e[2] for t in tr.values() for e in t)//BAR+1
print('last bar',last)
# sections: name, first bar, end bar, [(track, shift, slot)]
SEC=[
 ('intro',1,6,[(10,12,0),(9,12,1),(3,0,2),(8,12,3)]),
 ('dial',6,22,[(9,12,1),(10,12,2),(8,0,3),(1,-12,4),(2,0,0)]),
 ('seq',22,35,[(10,12,1),(9,12,2),(8,12,3),(5,12,4),(3,0,0)]),
 ('horn',59,71,[(5,12,1),(9,12,2),(8,0,3),(10,12,4)]),
 ('dev',110,127,[(1,-12,1),(2,0,2),(8,0,3),(3,0,4),(9,12,0)]),
 ('ff',240,252,[(10,12,0),(1,-12,1),(9,12,2),(8,0,3),(2,0,4)]),
 ('coda',485,last+1,[(10,12,0),(1,-12,1),(9,12,2),(8,0,3),(2,0,4)]),
]
out={'sections':[], 'cap':16}
for name,b0,b1,voices in SEC:
    t0=(b0-1)*BAR;t1=(b1-1)*BAR;steps=(t1-t0)//STEP
    sec={'name':name,'steps':steps,'bars':b1-b0,'voices':{}, 'bass':[]}
    for trk,shift,slot in voices:
        by={}
        for _,s,d,m,v in tr[trk]:
            if t0<=s<t1: by.setdefault(round((s-t0)/STEP),[]).append((m+shift,max(1,round(d/STEP))))
        evs=[[k,sorted(set(m for m,_ in by[k])),max(d for _,d in by[k])] for k in sorted(by)]
        sec['voices'].setdefault(str(slot),[]).append(evs)
    # bass root per score bar: lowest sounding note of tracks 11/12 at the bar start (else previous)
    prev=None
    for b in range(b0,b1):
        bs=(b-1)*BAR;best=None
        for trk in (11,12,7):
            for _,s,d,m,v in tr[trk]:
                if s<=bs+STEP*2 and s+d>bs and (best is None or m<best): best=m
        if best is None: best=prev
        sec['bass'].append(best); prev=best if best is not None else prev
    out['sections'].append(sec)
json.dump(out,open('score.json','w'))
for s in out['sections']:
    print(s['name'],s['bars'],'bars',s['steps'],'steps','bass',s['bass'][:20])
    for k,v in s['voices'].items(): print('  slot',k,[len(x) for x in v],'notes', [m for x in v for e in x[:3] for m in e[1]][:8])
