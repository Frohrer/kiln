#!/bin/bash

PREFIX=$(realpath $(dirname $0))

mkdir -p build

cd build

curl "https://www.python.org/ftp/python/3.13.1/Python-3.13.1.tgz" -o python.tar.gz
tar xzf python.tar.gz --strip-components=1
rm python.tar.gz

./configure --prefix "$PREFIX" --with-ensurepip=install
make -j$(nproc)
make install -j$(nproc)

cd ..

rm -rf build

pip3 install numpy pillow requests pandas matplotlib scipy flask django beautifulsoup4 boto3 botocore urllib3 grpcio-status aiobotocore certifi charset-normalizer setuptools s3fs idna s3transfer typing-extensions python-dateutil fsspec packaging google-api-core six pyyaml cryptography  whoosh bcrypt passlib sympy