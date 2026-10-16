# SPIKE: Selkies + 32-битные библиотеки NVIDIA для 32-битного клиента Steam.
# NVIDIA Container Toolkit прокидывает только 64-битные; версия должна совпадать с драйвером хоста.
# Контекст сборки: nv/x/32 — распакованный NVIDIA-Linux-x86_64-<ver>.run (--extract-only).
FROM ghcr.io/selkies-project/selkies-egl-desktop:26.04
ARG NV_VER=550.163.01
USER root
COPY nv/x/32/libGLX_nvidia.so.${NV_VER} \
     nv/x/32/libEGL_nvidia.so.${NV_VER} \
     nv/x/32/libGLESv1_CM_nvidia.so.${NV_VER} \
     nv/x/32/libGLESv2_nvidia.so.${NV_VER} \
     nv/x/32/libnvidia-glcore.so.${NV_VER} \
     nv/x/32/libnvidia-glsi.so.${NV_VER} \
     nv/x/32/libnvidia-tls.so.${NV_VER} \
     nv/x/32/libnvidia-eglcore.so.${NV_VER} \
     nv/x/32/libnvidia-glvkspirv.so.${NV_VER} \
     nv/x/32/libnvidia-gpucomp.so.${NV_VER} \
     nv/x/32/libnvidia-allocator.so.${NV_VER} \
     nv/x/32/libnvidia-ml.so.${NV_VER} \
     nv/x/32/libcuda.so.${NV_VER} \
     /usr/lib/i386-linux-gnu/
COPY nv/x/32/libvdpau_nvidia.so.${NV_VER} /usr/lib/i386-linux-gnu/vdpau/
RUN ldconfig && ls -l /usr/lib/i386-linux-gnu/libGLX_nvidia.so.0
USER 1000
