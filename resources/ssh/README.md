# Setup Git with GitLab

Instructions on setting up your computer to be able to work with Git and GitLab.

Lots of information was taken and adapted from https://happygitwithr.com
Thanks go to Jenny Bryan, the STAT 545 TAs and Jim Hester for the great book!

This specific guide was copied over and adapted from: https://gitlab.com/digital-research-academy/setup-git-gitlab, initally set up by [@heidiseibold](https://gitlab.com/heidiseibold).

# Download and install Git


### Git already installed?

Open the `Terminal` (or `Shell`). This can be done as follows:
- **Window:** Click on the Windows Start menu icon (usually located in the bottom-left corner of the screen). Type "Command Prompt" or "PowerShell" into the search bar. Press Enter to open the Command Prompt or PowerShell.
- **Mac:** Press Command + Spacebar to open Spotlight Search. Type "Terminal" into the search bar. Press Enter to launch Terminal when it appears in the search results.
- **Linux:** The default keyboard shortcut to open the terminal on many Linux distributions is usually `Ctrl + Alt + T`. Pressing these keys simultaneously should open the terminal.

Enter `git --version` to see your git version (if any):
 
```
git --version
```

If you are successful, that's great! You have Git already. No need to install! Move on.

If, instead, you see something more like `git: command not found`, keep reading.

Mac OS users might get an immediate offer to install command line developer tools. Yes, you should accept! Click "Install" and read more below.

### Windows  

Install [Git for Windows](https://git-for-windows.github.io/), also known as `msysgit` or "Git Bash", to get Git in addition to some other useful tools, such as the Bash shell. Yes, all those names are totally confusing, but you might encounter them elsewhere and I want you to be well-informed.

We like this because Git for Windows leaves the Git executable in a conventional location, which will help you and other programs, e.g. RStudio, find it and use it. This also supports a transition to more expert use, because the "Git Bash" shell will be useful as you venture outside of R/RStudio.

  *  **NOTE:** Select "Use Git from the Windows Command Prompt" during installation. Otherwise, we believe it's OK to accept the defaults.

  


### Mac OS

There are several options. Please read through them and pick the one you feel will suit you best.

**Option 1**: Install the Xcode command line tools (**not all of Xcode**), which includes Git. If your OS is older than 10.11 El Capitan, it is possible that you **must** install the Xcode command line tools in order for RStudio to find and use Git.

Go to the shell and enter one of these commands to elicit an offer to install developer command line tools:

``` 
git --version
git config
```

Accept the offer! Click on "Install".

Here's another way to request this installation, more directly:

``` 
xcode-select --install
```

We just happen to find this Git-based trigger apropos.

Note also that, after upgrading your Mac OS, you might need to re-do the above and/or re-agree to the Xcode license agreement. We have seen this cause the RStudio Git pane to disappear on a system where it was previously working. Use commands like those above to tickle Xcode into prompting you for what it needs, then restart RStudio.

**Option 2**: Install Git from here: <http://git-scm.com/downloads>.

  * This arguably sets you up the best for the future. It will certainly get you the latest version of Git of all approaches described here.
  * The GitHub home for this project is here: <https://github.com/timcharper/git_osx_installer>.
    - At that link, there is a list of maintained builds for various combinations of Git and Mac OS version. If you're running 10.7 Lion and struggling, we've had success in September 2015 with binaries found here: <https://www.wandisco.com/git/download>. 

**Option 3**: If you anticipate getting heavily into scientific computing, you're going to be installing and updating lots of software. You should check out [homebrew](http://brew.sh), "the missing package manager for OS X". Among many other things, it can install Git for you. Once you have Homebrew installed, do this in the shell:

```
brew install git
```



### Linux

Install Git via your distro's package manager.

Ubuntu or Debian Linux:

```sh
sudo apt-get install git
```

Fedora or RedHat Linux:

```sh
sudo yum install git
```

A comprehensive list for various Linux and Unix package managers:

<https://git-scm.com/download/linux>


## Test Installation

Open the `Terminal` (or `Shell`). 
Enter `git --version` to see your git version (if any):
 
```
git --version
```

If you are successful, that's great! If not, something went wrong. 
If you are stuck, please ask your IT or a knowledgeable friend for help.







# Prepare your GitLab account

Sign in to the Helmholtz GitLab: https://codebase.helmholtz.cloud/

The following setup instructions are adapted from [this Hifis lesson](https://codebase.helmholtz.cloud/hifis/software/education/hifis-workshops/introduction-to-git-and-gitlab/workshop-project-management-with-gitlab/-/blob/main/episodes/00-introduction/lesson.md?ref_type=heads#setting-up-ssh-keys).

## Setting up SSH keys

SSH keys are like a pair of special keys.
They come in pairs for each combination of users and/or services:
* A _public_ key that is given out to the service (GitLab in this case) who wants to communicate with the user
* A _private_ key that the user keeps secret

> Sharing your public keys with other people or services is completely fine and intended.
> Do however **not** share or re-use your private keys! This is a tremendous security risk!

This example is modified for use with the Helmholtz GitLab.
See also the full [documentation on `gitlab.com`](https://docs.gitlab.com/ee/ssh/)

### Step-by-step
1. Open the terminal
2. Run the command 
```bash
ssh-keygen -t ed25519 -C "you@example.com"
```

where `you@example.com` should be replaced with your email address associated with your GitLab login. If you don't know which email that is, go to [your round profile avatar -> edit profile](https://codebase.helmholtz.cloud/-/user_settings/profile) and scroll down to see your `Email`.

3. When prompted for the directory and file name, note down the directory you save it in (by default `~/.ssh/`) and give it a more helpful name (e.g. `helmholtz_gitlab_ed25519`). This is what it looked like for me:
```
heidi $ ssh-keygen -t ed25519 -C "inbox@heidiseibold.de"                        [9:57:54]
Generating public/private ed25519 key pair.
Enter file in which to save the key (/Users/heidi/.ssh/id_ed25519): /Users/heidi/.ssh/helmholtz_gitlab_ed25519
Enter passphrase (empty for no passphrase): 
Enter same passphrase again: 
Your identification has been saved in /Users/heidi/.ssh/helmholtz_gitlab_ed25519
Your public key has been saved in /Users/heidi/.ssh/helmholtz_gitlab_ed25519.pub
``` 
4. Display the newly generated public key via `cat ~/.ssh/helmholtz_gitlab_ed25519.pub` or simply open the file in a text editor (it is called `helmholtz_gitlab_ed25519.pub` and is stored in the hidden folder `.ssh`. 
5. Select and copy the output (if you used `cat ~/.ssh/helmholtz_gitlab_ed25519.pub`) or just the entire text of the file. 
6. Sign in to GitLab, then:
  1. Click your round profile avatar 
  2. Click _Edit profile_
  3. In the left sidebar click _Access_ > _SSH Keys_
  4. Klick _Add new key_ and paste the key you copied into the _Key_ box. Make sure it starts with `ssh-ed25519` and ends with your email address. Otherwise you may have missed something while copying.
  5. In the _Title_ box enter a name to distinguish the key (in case there are multiple) e.g. `Macbook`
  6. Click _Add key_

To automatically use a given key for pushing to/pulling from GitLab create/edit the file `~/.ssh/config` (that means the file called `config` in the `.ssh` folder) and modify the following example:
```
# Configuration for Helmholtz Gitlab
Host codebase.helmholtz.cloud
  PreferredAuthentications publickey
  IdentityFile ~/.ssh/helmholtz_gitlab_ed25519
```


Test if it all worked by typing:
``` bash
ssh -T git@codebase.helmholtz.cloud
```
in the `Terminal`. If you are asked if you want to continue, type `yes`. 
In the end it should say something like `Welcome to GitLab, @HeidiSeibold!`. 
If this did not work, please ask your IT or a knowledgeable friend for help.

### Tell Git who you are

- Go to the `Terminal` 
- Type 
``` bash
git config --global user.email "you@example.com"
``` 
replace `you@example.com` with your e-mail address used on GitLab.
- Type 
``` bash
git config --global user.name "YourName"
``` 
replace `YourName` with your username on GitLab. It is the one that was shown
in the welcome message above (`Welcome to GitLab, @HeidiSeibold!` -> `HeidiSeibold` would be the username).



