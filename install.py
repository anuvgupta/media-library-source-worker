#!/usr/bin/env python3
"""
Media Library Source Worker Installation Script
Clones the repository, configures paths, and sets up the Docker worker.
"""

import os
import sys
import json
import shutil
import subprocess
import argparse
from pathlib import Path


def run_command(command, cwd=None, shell=True, check=True, allow_input=False):
    """Run a shell command and return the result."""
    try:
        if allow_input:
            # Allow user interaction with the subprocess
            result = subprocess.run(command, cwd=cwd, shell=shell, check=check)
            return result.returncode == 0
        else:
            result = subprocess.run(
                command,
                cwd=cwd,
                shell=shell,
                check=check,
                capture_output=True,
                text=True,
            )
            return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        if check:
            print(f"Error running command: {command}")
            print(f"Error: {e.stderr if hasattr(e, 'stderr') else str(e)}")
            return None
        return None


def check_docker():
    """Check if Docker and Docker CLI are installed."""
    print("Checking for Docker installation...")

    # Check if docker command exists
    docker_check = run_command("docker --version", check=False)
    if docker_check is None:
        print("ERROR: Docker is not installed or not in PATH.")
        print("Please install Docker from https://www.docker.com/get-started")
        return False

    print(f"✓ Docker found: {docker_check}")

    # Check if Docker CLI is available
    docker_cli_check = run_command("docker ps", check=False)
    if docker_cli_check is None:
        print("ERROR: Docker CLI is not accessible.")
        print("Make sure Docker daemon is running and you have proper permissions.")
        return False

    print("✓ Docker CLI is accessible")
    return True


def get_install_path():
    """Prompt user for installation path."""
    default_path = os.getcwd()
    print(f"\nInstallation Path")
    print(f"Default: {default_path}")
    user_input = input(
        "Enter installation path (press Enter for current folder): "
    ).strip()

    if not user_input:
        return default_path

    install_path = os.path.abspath(os.path.expanduser(user_input))

    # Create directory if it doesn't exist
    if not os.path.exists(install_path):
        try:
            os.makedirs(install_path)
            print(f"Created directory: {install_path}")
        except Exception as e:
            print(f"Error creating directory: {e}")
            sys.exit(1)

    return install_path


def clone_repository(install_path):
    """Clone the repository into the installation folder."""
    repo_url = "https://github.com/anuvgupta/media-library-source-worker"
    repo_name = "media-library-source-worker"
    repo_path = os.path.join(install_path, repo_name)

    # Remove existing repository if it exists
    if os.path.exists(repo_path):
        print(f"\nRemoving existing repository at {repo_path}...")
        try:
            shutil.rmtree(repo_path)
            print("✓ Existing repository removed")
        except Exception as e:
            print(f"Error removing existing repository: {e}")
            sys.exit(1)

    # Clone the repository
    print(f"\nCloning repository from {repo_url}...")
    result = run_command(f"git clone {repo_url}", cwd=install_path)

    if result is None:
        print("ERROR: Failed to clone repository. Make sure git is installed.")
        sys.exit(1)

    print(f"✓ Repository cloned to {repo_path}")
    return repo_path


def get_library_path():
    """Prompt user for library path with examples."""
    print("\nMovie Library Path")
    print("Please provide the full absolute path to your movie library.")
    print("\nExamples:")
    print("  - Windows (external drive): /e/Library")
    print("  - Windows (local folder):   /c/Users/yourusername/Videos/Library")
    print("  - macOS (external drive):   /Volumes/DRIVE_NAME/Library")
    print("  - macOS (local folder):     /Users/yourusername/Movies/Library")

    while True:
        library_path = input("\nEnter full absolute path to movie library: ").strip()

        if not library_path:
            print("ERROR: Library path cannot be empty.")
            continue

        # Expand user path
        library_path = os.path.expanduser(library_path)

        # Warn if path doesn't exist (but don't block)
        if not os.path.exists(library_path):
            response = (
                input(
                    f"WARNING: Path '{library_path}' does not exist. Continue anyway? (y/n): "
                )
                .strip()
                .lower()
            )
            if response != "y":
                continue

        return library_path


def get_collection_path(collection_type, default_value):
    """Prompt user for collection path within library."""
    print(f"\n{collection_type} Collection Path")
    print(
        f"Enter the path of the {collection_type.lower()} collection within the library folder."
    )
    print(f"Suggested: {default_value}")

    user_input = input(f"Enter path (press Enter for '{default_value}'): ").strip()

    return user_input if user_input else default_value


def update_config(repo_path, library_path, movie_path, tv_path, is_dev):
    """Update the configuration file with user-provided paths."""
    config_file = "dev.json" if is_dev else "prod.json"
    config_path = os.path.join(repo_path, "config", config_file)

    print(f"\nUpdating configuration file: {config_file}")

    if not os.path.exists(config_path):
        print(f"ERROR: Configuration file not found at {config_path}")
        sys.exit(1)

    try:
        # Load existing config
        with open(config_path, "r") as f:
            config = json.load(f)

        # Update paths
        config["libraryPath"] = library_path
        config["libraryMoviePath"] = movie_path
        config["libraryTvPath"] = tv_path

        # Save updated config
        with open(config_path, "w") as f:
            json.dump(config, f, indent=2)

        print("✓ Configuration updated successfully")
        print(f"  - libraryPath: {library_path}")
        print(f"  - libraryMoviePath: {movie_path}")
        print(f"  - libraryTvPath: {tv_path}")

    except Exception as e:
        print(f"ERROR: Failed to update configuration: {e}")
        sys.exit(1)


def run_setup_scripts(repo_path, is_dev):
    """Run the build, setup, stop, and start scripts."""
    env = os.environ.copy()
    if is_dev:
        env["STAGE"] = "dev"
        print("\nRunning in DEV mode (STAGE=dev)")

    print("\n" + "=" * 60)
    print("Running build-worker.sh...")
    print("=" * 60)
    process = subprocess.Popen(
        "bash ./build-worker.sh", cwd=repo_path, shell=True, env=env
    )
    process.wait()
    if process.returncode != 0:
        print("ERROR: build-worker.sh failed")
        sys.exit(1)

    print("\n" + "=" * 60)
    print("Running setup-worker.sh...")
    print("=" * 60)
    process = subprocess.Popen(
        "bash ./setup-worker.sh", cwd=repo_path, shell=True, env=env
    )
    process.wait()
    if process.returncode != 0:
        print("ERROR: setup-worker.sh failed")
        sys.exit(1)

    print("\n" + "=" * 60)
    print("Running stop-worker.sh...")
    print("=" * 60)
    process = subprocess.Popen(
        "bash ./stop-worker.sh", cwd=repo_path, shell=True, env=env
    )
    process.wait()
    if process.returncode != 0:
        print("WARNING: stop-worker.sh failed (worker may not have been running)")

    print("\n" + "=" * 60)
    print("Running start-worker.sh...")
    print("=" * 60)
    process = subprocess.Popen(
        "bash ./start-worker.sh", cwd=repo_path, shell=True, env=env
    )
    process.wait()
    if process.returncode != 0:
        print("ERROR: start-worker.sh failed")
        sys.exit(1)


def main():
    """Main installation workflow."""
    parser = argparse.ArgumentParser(
        description="Install and configure Media Library Source Worker"
    )
    parser.add_argument(
        "--dev",
        action="store_true",
        help="Run in development mode (uses dev.json and STAGE=dev)",
    )
    args = parser.parse_args()

    print("=" * 60)
    print("Media Library Source Worker - Installation Script")
    print("=" * 60)

    # Step 1: Get installation path
    install_path = get_install_path()

    # Step 2: Clone repository
    repo_path = clone_repository(install_path)

    # Step 3: Check Docker
    if not check_docker():
        sys.exit(1)

    # Step 4: Get library paths
    library_path = get_library_path()
    movie_path = get_collection_path("Movie", "Movies")
    tv_path = get_collection_path("TV Show", "TV")

    # Step 5: Update configuration
    update_config(repo_path, library_path, movie_path, tv_path, args.dev)

    # Step 6: Run setup scripts
    run_setup_scripts(repo_path, args.dev)

    print("\n" + "=" * 60)
    print("✓ Installation completed successfully!")
    print("=" * 60)
    print(f"Repository location: {repo_path}")
    print(f"Configuration mode: {'Development' if args.dev else 'Production'}")
    print(f"Library path: {library_path}")
    print(f"Movie collection: {movie_path}")
    print(f"TV collection: {tv_path}")

    print("")
    print("")

    print(
        'Please log in at https://streamy.sh and click "Refresh Index" to scan your library.'
    )


if __name__ == "__main__":
    main()
