#!/bin/bash

PREFIX=$(realpath $(dirname $0))

mkdir -p build

cd build

curl "https://www.python.org/ftp/python/3.11.11/Python-3.11.11.tgz" -o python.tar.gz
tar xzf python.tar.gz --strip-components=1
rm python.tar.gz

./configure --prefix "$PREFIX" --with-ensurepip=install
make -j$(nproc)
make install -j$(nproc)

cd ..

rm -rf build

# Upgrade pip first
pip3 install --upgrade pip

# Install packages in smaller groups
pip3 install numpy pillow requests pandas matplotlib scipy
pip3 install flask django beautifulsoup4
pip3 install boto3 botocore urllib3 grpcio-status aiobotocore
pip3 install certifi charset-normalizer setuptools s3fs
pip3 install idna s3transfer typing-extensions python-dateutil
pip3 install fsspec packaging google-api-core six
pip3 install pyyaml cryptography whoosh
pip3 install bcrypt passlib sympy