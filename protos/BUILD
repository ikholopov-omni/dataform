load("@rules_proto//proto:defs.bzl", "proto_library")
load("//tools:ts_proto_library.bzl", "ts_proto_library")

package(default_visibility = ["//visibility:public"])

proto_library(
    name = "dataform_proto",
    srcs = [
        "configs.proto",
        "core.proto",
        "evaluation.proto",
        "execution.proto",
        "jit.proto",
        "profiles.proto",
    ],
    deps = ["struct_proto"],
)

proto_library(
    name = "struct_proto",
    srcs = ["struct.proto"],
)

ts_proto_library(
    name = "ts",
    deps = [
        ":dataform_proto",
    ],
)
