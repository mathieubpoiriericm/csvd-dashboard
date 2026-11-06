# Workarounds for building Tracy's Python client wheel (third_party/tracy/python)
# on macOS, injected by scripts/tracy.sh through CMAKE_PROJECT_Tracy_INCLUDE. That
# runs right after the root `project(Tracy LANGUAGES CXX)`, before vendor.cmake
# and python/CMakeLists.txt are read.
#
# Each workaround names the Tracy version it was found on. After a Tracy bump,
# rebuild with `deno task tracy:build` and delete any block that is no longer
# needed. The tracy skill has the procedure.

# 1. (v0.15.0) The wheel also builds TracyServerBindings, whose vendor.cmake
#    adds TracyGetOpt, a C library. The root project enables only C++, so the
#    configure step fails with "Missing variable is: CMAKE_C_COMPILE_OBJECT".
#    The standalone tools declare `LANGUAGES C CXX` themselves and never hit this.
enable_language(C)

# 2. (v0.15.0) python/pyproject.toml sets CMAKE_INSTALL_BINDIR to "", and zstd's
#    programs/ install rules then fail with "install FILES given no
#    DESTINATION". Tracy needs only the library, not zstd's command-line tools.
set(ZSTD_BUILD_PROGRAMS OFF CACHE BOOL "Tracy needs libzstd only" FORCE)

if(APPLE)
    # 3. (v0.15.0) python/CMakeLists.txt links both bindings against
    #    ${Python_LIBRARIES}, an absolute path to libpython. uv's interpreters
    #    are statically linked, so importing the extension starts a second,
    #    uninitialised runtime and dies with "Fatal Python error: take_gil".
    #    pybind11::module already passes -undefined dynamic_lookup, which is
    #    how a macOS extension is meant to reach the host interpreter. It also
    #    sets INSTALL_RPATH to $ORIGIN/lib, which macOS's loader does not
    #    understand; the client dylib sits in tracy_client/lib/, next to the
    #    bindings.
    function(_tracy_python_fixups)
        foreach(target TracyClientBindings TracyServerBindings)
            # Loud, not skipped: a renamed target would otherwise drop this
            # fix silently, and the wheel would only crash at import.
            if(NOT TARGET ${target})
                message(FATAL_ERROR "tracy_python_fixups.cmake: no target ${target}; "
                    "Tracy's python/CMakeLists.txt changed, so revisit workaround 3")
            endif()
            foreach(property LINK_LIBRARIES INTERFACE_LINK_LIBRARIES)
                get_target_property(libraries ${target} ${property})
                if(libraries)
                    list(FILTER libraries EXCLUDE REGEX "/libpython[0-9.]+\\.(dylib|a)$")
                    set_property(TARGET ${target} PROPERTY ${property} "${libraries}")
                endif()
            endforeach()
            set_property(TARGET ${target} PROPERTY INSTALL_RPATH "@loader_path/lib")
        endforeach()
    endfunction()
    cmake_language(DEFER DIRECTORY "${CMAKE_SOURCE_DIR}" CALL _tracy_python_fixups)
endif()
