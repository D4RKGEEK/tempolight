import numpy as np, subprocess
from scipy.signal import butter, lfilter
SR=44100; rng=np.random.default_rng(1)
def lp(x,f): b,a=butter(2,f/(SR/2)); return lfilter(b,a,x)
def note(m): return 440*2**((m-69)/12)
def piano(m,dur,vel):
    n=int(dur*SR); t=np.arange(n)/SR; f=note(m)
    s=sum(np.sin(2*np.pi*f*k*t)/k**1.6 for k in range(1,6))*np.exp(-t*2.2)
    return s*vel
def pad(ms,dur):
    n=int(dur*SR); t=np.arange(n)/SR; o=np.zeros(n)
    for m in ms:
        for d in (-0.1,0,0.1): o+=2*((note(m)*2**(d/12)*t+rng.random())%1)-1
    return lp(o,900)/len(ms)/3*np.minimum(1,t/0.8)*np.minimum(1,(dur-t)/0.8)
def kick(g=1):
    n=int(0.4*SR); t=np.arange(n)/SR; f=45+80*np.exp(-t*25); return np.sin(2*np.pi*np.cumsum(f)/SR)*np.exp(-t*6)*g
def snare(g=1):
    n=int(0.25*SR); t=np.arange(n)/SR; return (lp(rng.standard_normal(n),6000)*np.exp(-t*16)*0.6+np.sin(2*np.pi*200*t)*np.exp(-t*25)*0.4)*g
def add(mix,s,t,g=1):
    i=int(t*SR); j=min(len(mix),i+len(s)); mix[i:j]+=s[:j-i]*g
chords=[[57,60,64],[53,57,60],[48,52,55],[55,59,62]]
def write(name,mix):
    mix=mix/np.max(np.abs(mix))*0.9
    (mix.astype(np.float32)).tofile(name+'.f32')
    subprocess.run(['ffmpeg','-v','error','-y','-f','f32le','-ar',str(SR),'-ac','1','-i',name+'.f32','-c:a','libmp3lame','-b:a','128k',name+'.mp3'],check=True)
# ballad: 70 bpm, no drums, quiet verse -> loud chorus -> quiet
bpm=70; beat=60/bpm; bar=4*beat; nb=16; mix=np.zeros(int((nb*bar+2)*SR))
for b in range(nb):
    t0=b*bar; ci=b%4; loud = 1.0 if 8<=b<12 else (0.55 if 4<=b<8 else 0.3)
    add(mix,pad(chords[ci],bar),t0,0.5*loud)
    for k in range(4): add(mix,piano(chords[ci][k%3]+12,1.5,0.5*loud),t0+k*beat)
    add(mix,piano(chords[ci][0]-12,3,0.6*loud),t0)
write('ballad',mix)
# hiphop: 88 bpm boom bap
bpm=88; beat=60/bpm; bar=4*beat; nb=16; mix=np.zeros(int((nb*bar+2)*SR))
for b in range(nb):
    t0=b*bar; ci=b%4
    add(mix,pad(chords[ci],bar),t0,0.35)
    for k,(kk) in enumerate([0,0.75,2.5]): add(mix,kick(),t0+kk*beat)
    for k in (1,3): add(mix,snare(),t0+k*beat,0.8)
    for k in range(8): add(mix,lp(rng.standard_normal(int(0.04*SR)),9000)*0.1,t0+k*beat/2)
    add(mix,lp(2*((note(chords[ci][0]-24)*np.arange(int(bar*SR))/SR)%1)-1,200)*0.5,t0)
write('hiphop',mix)
