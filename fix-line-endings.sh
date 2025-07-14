#!/bin/bash
find . -name "*.sh" -exec dos2unix {} \;
find . -name "*.bash" -exec dos2unix {} \;
