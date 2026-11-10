import sys
import os
import subprocess
import shutil
import glob

def find_edge_tts():
    # 1. System PATH
    p = shutil.which("edge-tts")
    if p:
        return [p]
    # 2. Inside HERMES_HOME venvs
    hermes_home = os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes"))
    matches = glob.glob(os.path.join(hermes_home, "installs/**/bin/edge-tts"), recursive=True)
    if matches:
        return [matches[0]]
    # 3. Fallback to python3 -m edge_tts
    return ["python3", "-m", "edge_tts"]

def build_voice_mp3(text, out_mp3):
    if not shutil.which("ffmpeg"):
        print("ffmpeg not found, skipping audio generation", file=sys.stderr)
        return False

    script_dir = os.path.dirname(os.path.abspath(__file__))
    blip_wav = os.path.join(script_dir, "..", "web", "sounds", "cyber_blip.wav")
    if not os.path.exists(blip_wav):
        blip_wav = "/tmp/cyberpunk_voice/cyber_blip.wav"

    raw_mp3 = out_mp3 + ".raw.mp3"
    fx_wav = out_mp3 + ".fx.wav"
    
    # 1. Edge-TTS with AriaNeural
    cmd_edge = find_edge_tts() + ["--voice", "en-US-AriaNeural", "--rate=+4%", "--pitch=+2Hz", "--text", text, "--write-media", raw_mp3]
    try:
        subprocess.run(cmd_edge, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        print(f"edge-tts failed: {e}", file=sys.stderr)
        return False

    # 2. Filter voice: highpass, treble presence, spatial reverb, chorus
    filter_chain = (
        "silenceremove=start_periods=1:start_threshold=-40dB,areverse,silenceremove=start_periods=1:start_threshold=-40dB,areverse,"
        "highpass=f=240,lowpass=f=9500,treble=g=4:f=3500,volume=1.3,"
        "aecho=0.85:0.75:24|32:0.3|0.2,"
        "aecho=0.9:0.65:60|75:0.2|0.15"
    )
    try:
        subprocess.run(["ffmpeg", "-y", "-i", raw_mp3, "-af", filter_chain, fx_wav], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        print(f"ffmpeg filter failed: {e}", file=sys.stderr)
        if os.path.exists(raw_mp3): os.remove(raw_mp3)
        return False

    # 3. Prepend cyber blip and encode to mp3
    try:
        if os.path.exists(blip_wav):
            concat_cmd = [
                "ffmpeg", "-y", "-i", blip_wav, "-i", fx_wav,
                "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[out]",
                "-map", "[out]", "-b:a", "160k", out_mp3
            ]
        else:
            concat_cmd = ["ffmpeg", "-y", "-i", fx_wav, "-b:a", "160k", out_mp3]
        subprocess.run(concat_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except Exception as e:
        print(f"ffmpeg concat failed: {e}", file=sys.stderr)
        return False
    finally:
        if os.path.exists(raw_mp3): os.remove(raw_mp3)
        if os.path.exists(fx_wav): os.remove(fx_wav)

if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(1)
    text = sys.argv[1]
    out = sys.argv[2]
    ok = build_voice_mp3(text, out)
    if ok:
        print("Done:", out)
    else:
        sys.exit(1)
