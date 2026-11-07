"""Read a PyTorch .pt file (the zip format) into numpy arrays without torch.

Only tensors, parameters and plain containers are allowed: any other class in the pickle is refused, so a .pt file
can't run code here. Used by convert-beatnet.py.
"""
import collections
import pickle
import zipfile

import numpy as np

DT = {"FloatStorage": np.float32, "DoubleStorage": np.float64, "HalfStorage": np.float16, "LongStorage": np.int64,
      "IntStorage": np.int32, "ShortStorage": np.int16, "CharStorage": np.int8, "ByteStorage": np.uint8,
      "BoolStorage": np.bool_}


class _Storage:
    def __init__(self, name):
        self.name = name


def _rebuild_tensor_v2(storage, offset, size, stride, *rest):
    arr, = storage
    if not size:
        return arr[offset:offset + 1].reshape(())
    item = arr.itemsize
    return np.lib.stride_tricks.as_strided(arr[offset:], shape=tuple(size),
                                           strides=tuple(s * item for s in stride)).copy()


def _rebuild_parameter(data, requires_grad, backward_hooks, *rest):
    return data


def load(path):
    """The pickled object (usually a state_dict: name -> numpy array)."""
    z = zipfile.ZipFile(path)
    root = z.namelist()[0].split("/")[0]

    class U(pickle.Unpickler):
        def find_class(self, mod, name):
            if mod == "torch._utils" and name == "_rebuild_tensor_v2":
                return _rebuild_tensor_v2
            if mod == "torch._utils" and name == "_rebuild_parameter":
                return _rebuild_parameter
            if mod == "torch" and name.endswith("Storage") and name in DT:
                return _Storage(name)
            if mod == "collections" and name == "OrderedDict":
                return collections.OrderedDict
            raise pickle.UnpicklingError(f"refusing {mod}.{name}")

        def persistent_load(self, pid):
            _, storage_type, key, location, numel = pid
            buf = z.read(f"{root}/data/{key}")
            return (np.frombuffer(buf, dtype=DT[storage_type.name]),)

    return U(z.open(f"{root}/data.pkl")).load()
