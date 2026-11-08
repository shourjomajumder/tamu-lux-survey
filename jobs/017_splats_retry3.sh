#!/usr/bin/env bash
# Retry 3: train without the unsupported --save_ply flag; convert the checkpoint to .splat.
set -x
export PATH=/usr/local/cuda-12.4/bin:$PATH CUDA_HOME=/usr/local/cuda-12.4 TORCH_CUDA_ARCH_LIST="8.6"
grep -viE "fused|^git|^#" /root/gsplat/examples/requirements.txt > /tmp/req.txt; /root/splatenv/bin/pip install -q -r /tmp/req.txt matplotlib scikit-image splines 2>&1 | tail -2
mkdir -p /data/web/splats
for d in /data/splat/spot1 /data/splat/spot2; do
  [ -d "$d" ] || continue
  n=$(basename $d); echo "=== $n"
  if [ ! -d $d/sparse/0 ]; then
    rm -rf $d/sparse $d/db.db; mkdir -p $d/sparse
    colmap feature_extractor --database_path $d/db.db --image_path $d/images --ImageReader.single_camera 1 \
        --ImageReader.camera_model OPENCV --SiftExtraction.use_gpu 0 --SiftExtraction.max_image_size 1600 >/dev/null 2>&1
    colmap exhaustive_matcher --database_path $d/db.db --SiftMatching.use_gpu 0 >/dev/null 2>&1
    colmap mapper --database_path $d/db.db --image_path $d/images --output_path $d/sparse >/dev/null 2>&1
  fi
  [ -d $d/sparse/0 ] || { echo "$n: COLMAP could not reconstruct"; continue; }
  colmap model_analyzer --path $d/sparse/0 2>&1 | grep -iE "registered images|points"
  ( cd /root/gsplat/examples && /root/splatenv/bin/python simple_trainer.py default --data_dir $d --data_factor 2 \
      --result_dir $d/out --max_steps 12000 --disable_viewer ) 2>&1 | grep -vE "it/s|^\s*$" | tail -25
  ck=$(ls -t $d/out/ckpts/*.pt 2>/dev/null | head -1)
  [ -n "$ck" ] && /root/splatenv/bin/python pipeline/ckpt_to_splat.py "$ck" /data/web/splats/$n.splat 500000
done
cp /data/splat/spots.json /data/web/splats/ 2>/dev/null
cd /data/web && zip -qr splats.zip splats && ls -lh /data/web/splats /data/web/splats.zip
