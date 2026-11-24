import struct,sys,json
d=open('s5.mid','rb').read()
fmt,n,div=struct.unpack('>HHH',d[8:14]);p=14
def vlq(p):
    v=0
    while True:
        b=d[p];p+=1;v=(v<<7)|(b&127)
        if not b&128:return v,p
tracks=[]
for _ in range(n):
    assert d[p:p+4]==b'MTrk';ln=struct.unpack('>I',d[p+4:p+8])[0];e=p+8+ln;p+=8;t=0;run=0;name='';ev=[];on={}
    while p<e:
        dt,p=vlq(p);t+=dt;b=d[p]
        if b==0xFF:
            ty=d[p+1];l,p2=vlq(p+2);dat=d[p2:p2+l];p=p2+l
            if ty==3:name=dat.decode('latin1')
            if ty==0x58:ev.append(('ts',t,dat[0],2**dat[1]))
            if ty==0x51:ev.append(('tempo',t,int.from_bytes(dat,'big')))
            continue
        if b in(0xF0,0xF7):l,p=vlq(p+1);p+=l;continue
        if b&128:run=b;p+=1
        st=run&0xF0
        if st in(0x80,0x90,0xA0,0xB0,0xE0):a,c=d[p],d[p+1];p+=2
        else:a=d[p];c=0;p+=1
        if st==0x90 and c>0:on[a]=(t,c)
        elif st==0x80 or (st==0x90 and c==0):
            if a in on:s,v=on.pop(a);ev.append(('n',s,t-s,a,v))
    tracks.append((name,ev))
json.dump({'div':div,'tracks':tracks},open('s5.json','w'))
print(fmt,n,div)
for i,(nm,ev) in enumerate(tracks):
    ns=[e for e in ev if e[0]=='n']
    print(i,repr(nm),len(ns),[e for e in ev if e[0] in('ts','tempo')][:3], (min(e[3] for e in ns),max(e[3] for e in ns)) if ns else '')
