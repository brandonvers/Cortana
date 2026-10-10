# Changelog

## [0.1.0](https://github.com/brandonvers/Cortana/compare/v0.0.1...v0.1.0) (2026-10-10)


### Features

* **agent:** the disposable agent, under a profile nobody wrote by hand ([#60](https://github.com/brandonvers/Cortana/issues/60)) ([2efe47f](https://github.com/brandonvers/Cortana/commit/2efe47fc96985f22d8489cd0fefd7b56bca52070))
* **agent:** the profile stops being computed and starts being applied ([#58](https://github.com/brandonvers/Cortana/issues/58)) ([948fa1e](https://github.com/brandonvers/Cortana/commit/948fa1eb2310167280c70520636aeb2b29d90254))
* **audit:** record every turn before its result is handed back ([#52](https://github.com/brandonvers/Cortana/issues/52)) ([9520981](https://github.com/brandonvers/Cortana/commit/952098194eb759127114d0f338d0e774f4c62af4))
* **audit:** report the spread rather than an average, and stop discarding the warnings ([#53](https://github.com/brandonvers/Cortana/issues/53)) ([83fddb9](https://github.com/brandonvers/Cortana/commit/83fddb98db3534a4b1ca8c359ee45246a8f1eccd))
* **bus:** the compile-time contract ADR-0011 promised, in a package modules can import ([#39](https://github.com/brandonvers/Cortana/issues/39)) ([ac29f57](https://github.com/brandonvers/Cortana/commit/ac29f579c9c20aeabed70a11a8ef87d8d321aaa3))
* **channel:** a socket with no authentication to get wrong ([#57](https://github.com/brandonvers/Cortana/issues/57)) ([6490313](https://github.com/brandonvers/Cortana/commit/6490313876ad6ae992c5902315e028564a1637a4))
* **config:** the settings, where they come from, and a value that cannot be logged ([#35](https://github.com/brandonvers/Cortana/issues/35)) ([ff460ee](https://github.com/brandonvers/Cortana/commit/ff460eeea7b9b3bf83152b59f3aa9f4500f93dbc))
* **core:** identifiers a compiler can tell apart, categorised errors, and time as a port ([#33](https://github.com/brandonvers/Cortana/issues/33)) ([fe59bf1](https://github.com/brandonvers/Cortana/commit/fe59bf1fafe6b83e3488f66430eb7c14ad1a22d2))
* **daemon:** the process, and the Node fact that nearly made it look like a crash ([#42](https://github.com/brandonvers/Cortana/issues/42)) ([fdf8140](https://github.com/brandonvers/Cortana/commit/fdf81402b2c1df0c6f064177a3a60687055c9f2c))
* **daemon:** the server follows main, and puts the old version back when the new one fails ([#75](https://github.com/brandonvers/Cortana/issues/75)) ([9c77115](https://github.com/brandonvers/Cortana/commit/9c77115b37a33cb6e842e33e3904d67ccaafe42a))
* **daemon:** the service is given its credential, measured on the server it runs on ([#73](https://github.com/brandonvers/Cortana/issues/73)) ([e8ce743](https://github.com/brandonvers/Cortana/commit/e8ce7432a1833750317253dd3ceb7652bac7c558))
* **kernel:** hold all of it at once, and it answers you ([#61](https://github.com/brandonvers/Cortana/issues/61)) ([ce21fc8](https://github.com/brandonvers/Cortana/commit/ce21fc8fc4446d693196b850f19df775c76beb96))
* **kernel:** logging, with the redaction boundary measured rather than assumed ([#40](https://github.com/brandonvers/Cortana/issues/40)) ([0629be2](https://github.com/brandonvers/Cortana/commit/0629be2a638b909d83c04e002a5f511f2a72b670))
* **kernel:** report at boot what a credential on this machine would be worth ([#44](https://github.com/brandonvers/Cortana/issues/44)) ([1359d7d](https://github.com/brandonvers/Cortana/commit/1359d7d908af2064537ad0a5da3e1923169139de))
* **kernel:** start in order, stop in reverse, and say what a deadline cannot do ([#41](https://github.com/brandonvers/Cortana/issues/41)) ([593a10c](https://github.com/brandonvers/Cortana/commit/593a10cf1c3e6309b80ca0b018b6732b54624b45))
* **kernel:** the bot joins the daemon, and its token comes from the machine, not the config ([#72](https://github.com/brandonvers/Cortana/issues/72)) ([cf1e1aa](https://github.com/brandonvers/Cortana/commit/cf1e1aabed7802f0901c68829613dd79774a2af7))
* **policy:** a quarantine session was calling tools it was not given ([#59](https://github.com/brandonvers/Cortana/issues/59)) ([306712f](https://github.com/brandonvers/Cortana/commit/306712f9977b3eed6ab910d6a2d3af5c1951e4f0))
* **policy:** turn five spikes' findings into settings a test fails on ([#56](https://github.com/brandonvers/Cortana/issues/56)) ([7016028](https://github.com/brandonvers/Cortana/commit/7016028001d15b799a723caddeac6112fa38d666))
* **reports:** deliver a request's reports together, and never leave the asker unanswered ([#68](https://github.com/brandonvers/Cortana/issues/68)) ([a6fe3f4](https://github.com/brandonvers/Cortana/commit/a6fe3f4e22bbd33bf7e0b84d2c40bbd79fb8f622))
* **reports:** reports that survive the process, promoted without the spike's two bugs ([#67](https://github.com/brandonvers/Cortana/issues/67)) ([1dba54d](https://github.com/brandonvers/Cortana/commit/1dba54dab36b77ff4d753ab75cf56eebd6cf8bc4))
* **roster:** dormancy, and the three bugs that finding it required ([#65](https://github.com/brandonvers/Cortana/issues/65)) ([f73d1b1](https://github.com/brandonvers/Cortana/commit/f73d1b1e5c61f076036e87816940c4322f4c99df))
* **roster:** who the agents are, from the two places they come from ([#64](https://github.com/brandonvers/Cortana/issues/64)) ([102b82f](https://github.com/brandonvers/Cortana/commit/102b82fe12016b7801d9828c6d36c601c7e7d9b4))
* **runner-claude:** the adapter, and the half of it CI can actually check ([#50](https://github.com/brandonvers/Cortana/issues/50)) ([7856d7d](https://github.com/brandonvers/Cortana/commit/7856d7d8430e358e2f3990cdfd1b6fa41e2a72f1))
* **runner:** the port, a second adapter, and the contract that makes it a port ([#47](https://github.com/brandonvers/Cortana/issues/47)) ([2a7c10b](https://github.com/brandonvers/Cortana/commit/2a7c10b807a19531756dc558fb82ff55214cfc01))
* **storage:** one serialised writer, and an honest account of what it protects ([#38](https://github.com/brandonvers/Cortana/issues/38)) ([01568ce](https://github.com/brandonvers/Cortana/commit/01568ce59ec10358bee61a80ece118beefd2a12b))
* **storage:** open the database, prove the settings took, and refuse a future schema ([#37](https://github.com/brandonvers/Cortana/issues/37)) ([993487b](https://github.com/brandonvers/Cortana/commit/993487bb49c50b9717b890c2faaf0672ad64dc11))
* **telegram:** a channel a phone can reach, that only the owner gets through ([#71](https://github.com/brandonvers/Cortana/issues/71)) ([636688a](https://github.com/brandonvers/Cortana/commit/636688aafcc358419fa1321fd6a4099d2287760c))


### Bug fixes

* **config:** the suite stops reading the machine's own /etc/cortana ([#74](https://github.com/brandonvers/Cortana/issues/74)) ([f104dfe](https://github.com/brandonvers/Cortana/commit/f104dfe5a072a23595fdb61ba2c5d18b6f0e476b))
* repair a broken merge and lint the spikes that hid it ([#9](https://github.com/brandonvers/Cortana/issues/9)) ([1aaace3](https://github.com/brandonvers/Cortana/commit/1aaace35967a9c965c98e100185c285a238054f8))
* **runner-claude:** a rate-limit state is not a warning, and headroom is not news ([#54](https://github.com/brandonvers/Cortana/issues/54)) ([3c813f9](https://github.com/brandonvers/Cortana/commit/3c813f95cae63c2e23e5dd491e7b904d0bdf9fc3))
* **runner-claude:** drop the schema dialect pointer the provider cannot resolve ([#51](https://github.com/brandonvers/Cortana/issues/51)) ([37dcabf](https://github.com/brandonvers/Cortana/commit/37dcabf52bdf3c6265cb217e4bee735f31adfd3f))
* **runner-claude:** say what the provider said, not what subtype it used ([#62](https://github.com/brandonvers/Cortana/issues/62)) ([a8c7811](https://github.com/brandonvers/Cortana/commit/a8c7811dffb120ee6bf9bc1c7b2134e610825ba3))
* **runner-claude:** two ways round the gate that were not calls, found moving to agent SDK 0.3.295 ([#69](https://github.com/brandonvers/Cortana/issues/69)) ([f55cf80](https://github.com/brandonvers/Cortana/commit/f55cf80bf9c94697a043b429be07640e5d64ca2f))
* **runner:** the answer's shape belongs to the session, not the turn ([#49](https://github.com/brandonvers/Cortana/issues/49)) ([fbf0601](https://github.com/brandonvers/Cortana/commit/fbf060177fbc35cce2831b82f1711dac12502221))
* **spike:** configure the native build for pnpm 11 ([#4](https://github.com/brandonvers/Cortana/issues/4)) ([d2dab59](https://github.com/brandonvers/Cortana/commit/d2dab592e6395457e81b00fd98cf54b4d44ff214))
* **spike:** sample every latency condition, not just one of them ([#8](https://github.com/brandonvers/Cortana/issues/8)) ([22c0102](https://github.com/brandonvers/Cortana/commit/22c0102ae043ff9a59fe292d6be3ae0a583b9123))
* three defects that only a real machine and a slow CI runner would find ([#45](https://github.com/brandonvers/Cortana/issues/45)) ([97b2e32](https://github.com/brandonvers/Cortana/commit/97b2e325027e983b7744b0fc64c8ccfc57548025))


### Documentation

* **0013:** record the headroom measurement, and a prediction that wa… ([#27](https://github.com/brandonvers/Cortana/issues/27)) ([69323c4](https://github.com/brandonvers/Cortana/commit/69323c4ac5045a83f6d4d8d501b796b57e8b7fe9))
* add ADR-0016 and correct nine claims the audit found ([#28](https://github.com/brandonvers/Cortana/issues/28)) ([0f1ecb0](https://github.com/brandonvers/Cortana/commit/0f1ecb0a74af23af546cd61d35a8c4524850d738))
* add concepts, decision records, and spike reports ([f2153c5](https://github.com/brandonvers/Cortana/commit/f2153c5fa2c6fc086a7121b6e0ef1248d90bbc0e))
* add licence, notice, and community health files ([88569f8](https://github.com/brandonvers/Cortana/commit/88569f85d013acc3d07b65a6419ce9a57151ae35))
* correct six claims the measurements no longer support ([#26](https://github.com/brandonvers/Cortana/issues/26)) ([26188e3](https://github.com/brandonvers/Cortana/commit/26188e3234b294de2cb9fd2cd32a7613ae51382d))
* plan first use, and pause M4 after step 4 to make room for it ([#70](https://github.com/brandonvers/Cortana/issues/70)) ([c777140](https://github.com/brandonvers/Cortana/commit/c777140983d3c04967848b4bb5c33c95bc487f8a))
* plan M1 before writing any of it ([#30](https://github.com/brandonvers/Cortana/issues/30)) ([8294398](https://github.com/brandonvers/Cortana/commit/82943982b81990b79761af65313c012c210ac150))
* plan M2, where the port stops being a promise ([#46](https://github.com/brandonvers/Cortana/issues/46)) ([84312ca](https://github.com/brandonvers/Cortana/commit/84312cafb2bba86ebb44e9781cf3013774b753f5))
* plan M3, and add the milestone the roadmap was missing ([#55](https://github.com/brandonvers/Cortana/issues/55)) ([3749d01](https://github.com/brandonvers/Cortana/commit/3749d011fd40377a7150cf483e52f74c3be9e45c))
* plan M4, the milestone that gives the agent colleagues ([#63](https://github.com/brandonvers/Cortana/issues/63)) ([3a2d6c0](https://github.com/brandonvers/Cortana/commit/3a2d6c0a375a74d5d13fa4e0e39ec67ab68f389c))
* record spike 0003 results and fix a badly designed criterion ([#7](https://github.com/brandonvers/Cortana/issues/7)) ([b731b3f](https://github.com/brandonvers/Cortana/commit/b731b3f0064ab628d69673f0906f2b024a7f5e49))
* record spike 0005 and add the ADR it exposed as missing ([#14](https://github.com/brandonvers/Cortana/issues/14)) ([868e3f4](https://github.com/brandonvers/Cortana/commit/868e3f4bb90af75e7a9e337c4c972efce8400b4b))
* record spike 0005 and add the ADR it exposed as missing ([#15](https://github.com/brandonvers/Cortana/issues/15)) ([fd081c6](https://github.com/brandonvers/Cortana/commit/fd081c611bcc68d8110a3fe92442129b32d1891d))
* record spike 0008 and correct ADR-0007's enforcement claim ([#20](https://github.com/brandonvers/Cortana/issues/20)) ([2ab83de](https://github.com/brandonvers/Cortana/commit/2ab83debe0c0df47e6817444ceb71c3919c9c128))
* record spike 0009 and close ADR-0015's cost question ([#21](https://github.com/brandonvers/Cortana/issues/21)) ([2df2446](https://github.com/brandonvers/Cortana/commit/2df24467060438c9c382cd1e06fe803cdb10c460))
* record the containment spike results ([#12](https://github.com/brandonvers/Cortana/issues/12)) ([e976797](https://github.com/brandonvers/Cortana/commit/e976797cb69ade462d4fd2d166c2e341a9cb1e6a))
* record the final spike 0003 measurement ([#10](https://github.com/brandonvers/Cortana/issues/10)) ([db07a85](https://github.com/brandonvers/Cortana/commit/db07a854bdb79537fdda27fc02d77eab63d97db9))
* record the Linux results for spike 0002 ([#5](https://github.com/brandonvers/Cortana/issues/5)) ([23d6f16](https://github.com/brandonvers/Cortana/commit/23d6f168a17d74b6f5288e7db643ac5703a0cdbd))
* say where things stand, now that the system is in use ([#76](https://github.com/brandonvers/Cortana/issues/76)) ([4a3ff69](https://github.com/brandonvers/Cortana/commit/4a3ff69550b071c57b43c989b8c81fb655e81a61))
* scope each blocker to the milestone it actually gates ([#29](https://github.com/brandonvers/Cortana/issues/29)) ([1b58da4](https://github.com/brandonvers/Cortana/commit/1b58da493b11d7773f6f6ce2f452c660762dd36b))
* stop the status claims drifting, and say when the first tag happens ([#32](https://github.com/brandonvers/Cortana/issues/32)) ([ebaea9d](https://github.com/brandonvers/Cortana/commit/ebaea9da356950262457042d297a4383815e5ccc))
* the provider SDK is proprietary, so the user installs it ([#48](https://github.com/brandonvers/Cortana/issues/48)) ([d02277c](https://github.com/brandonvers/Cortana/commit/d02277c80f6263e8648301bf8683cbe1380f7888))


### Build system

* add the workspace toolchain ([23aa88b](https://github.com/brandonvers/Cortana/commit/23aa88be92f4ff3e4866a74627ca8ef464a92b02))
* **deps:** agent SDK 0.3.272, and a check for what pnpm did to get there ([#66](https://github.com/brandonvers/Cortana/issues/66)) ([3549ba2](https://github.com/brandonvers/Cortana/commit/3549ba21721b6ba06a821bddca1e7c8f9dc858d8))

## Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See [docs/RELEASING.md](docs/RELEASING.md) for what each pre-release stage means
and what `1.0.0` will commit to.

Entries below this line are generated by
[release-please](https://github.com/googleapis/release-please) from Conventional
Commits. Edit the commits, not this file.

<!-- x-release-please-start -->
<!-- x-release-please-end -->
