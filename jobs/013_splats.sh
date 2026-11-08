#!/usr/bin/env bash
# Stretch: photo-real 3D Gaussian-splat scans of the 2 best-lit spots (COLMAP + gsplat). May fail on night photos.
set -x
export DEBIAN_FRONTEND=noninteractive
python pipeline/splat_pick.py || exit 1
# --- tools: COLMAP (CPU), CUDA 12.4 toolkit + a separate torch 2.4 env for gsplat
apt-get install -y -qq colmap >/dev/null 2>&1 || apt-get update -qq && apt-get install -y -qq colmap >/dev/null
if [ ! -x /usr/local/cuda-12.4/bin/nvcc ]; then
  wget -q https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb -O /tmp/ck.deb
  dpkg -i /tmp/ck.deb >/dev/null && apt-get update -qq && apt-get install -y -qq cuda-toolkit-12-4 >/dev/null
fi
export PATH=/usr/local/cuda-12.4/bin:$PATH CUDA_HOME=/usr/local/cuda-12.4 TORCH_CUDA_ARCH_LIST="8.6"
if [ ! -d /root/splatenv ]; then
  python3 -m venv /root/splatenv
  /root/splatenv/bin/pip install -q torch==2.4.1 torchvision==0.19.1 --index-url https://download.pytorch.org/whl/cu124
  /root/splatenv/bin/pip install -q gsplat==1.4.0 plyfile numpy==1.26.4 imageio tqdm tyro pyyaml scikit-learn opencv-python-headless \
      "pycolmap @ git+https://github.com/rmbrualla/pycolmap@cc7ea4b7301720ac29287dbe450952511b32125e" torchmetrics nerfview viser tensorboard
  /root/splatenv/bin/pip install -q --no-build-isolation "git+https://github.com/rahul-goel/fused-ssim@1272e21a282342e89537159e4bad508b19b34157" || true
  git clone -q --depth 1 --branch v1.4.0 https://github.com/nerfstudio-project/gsplat /root/gsplat
fi
mkdir -p /data/web/splats
for d in /data/splat/spot*; do
  n=$(basename $d); echo "=== $n"
  rm -rf $d/sparse $d/db.db; mkdir -p $d/sparse
  colmap feature_extractor --database_path $d/db.db --image_path $d/images --ImageReader.single_camera 1 \
      --ImageReader.camera_model OPENCV --SiftExtraction.use_gpu 0 --SiftExtraction.max_image_size 1600 || continue
  colmap sequential_matcher --database_path $d/db.db --SiftMatching.use_gpu 0 --SequentialMatching.overlap 20 || continue
  colmap mapper --database_path $d/db.db --image_path $d/images --output_path $d/sparse || continue
  [ -d $d/sparse/0 ] || { echo "$n: COLMAP could not reconstruct (too dark / too little parallax)"; continue; }
  echo "$n registered images: $(colmap model_analyzer --path $d/sparse/0 2>&1 | grep -i 'registered images')"
  ( cd /root/gsplat/examples && /root/splatenv/bin/python simple_trainer.py default --data_dir $d --data_factor 2 \
      --result_dir $d/out --max_steps 15000 --disable_viewer --save_ply --ply_steps 15000 ) 2>&1 | grep -vE "it/s|^\s*$" | tail -30
  ply=$(ls -t $d/out/ply/*.ply 2>/dev/null | head -1)
  [ -n "$ply" ] && /root/splatenv/bin/python pipeline/ply_to_splat.py "$ply" /data/web/splats/$n.splat 500000
done
cp /data/splat/spots.json /data/web/splats/ 2>/dev/null
ls -lh /data/web/splats
