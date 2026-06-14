// SPDX-License-Identifier: Apache-2.0
// https://gitbank.io
pragma solidity 0.8.34;

import "./GitStockToken.sol";

/**
 * @title GitStockFactory
 * @notice Deploys and tracks soul-bound GitStockToken contracts per ticker.
 *         One GitStockToken per stock ticker (e.g. gitNVDA, gitAAPL) is shared
 *         across all Gitbank users — each user has their own balance.
 *
 *         Only the Gitbank deployer EOA can register new stock tokens.
 *         The relayer (minter) is set once at construction and forwarded to
 *         every GitStockToken, keeping minting rights consistent.
 */
contract GitStockFactory {
    /// @notice Semver version tag — bumped so each deploy produces distinct bytecode.
    string public constant VERSION = "1.0.0";

    address public immutable minter;    // Gitbank relayerSigner EOA — can mint/burn
    address public immutable deployer;  // Gitbank deployer EOA — can add new stocks

    /// @notice ticker (uppercase) => GitStockToken contract address
    mapping(string => address) public stockByTicker;

    /// @notice All deployed tickers in insertion order
    string[] private _tickers;

    event GitStockDeployed(
        string  indexed ticker,
        address indexed token,
        string  name,
        string  symbol
    );

    modifier onlyDeployer() {
        require(msg.sender == deployer, "GitStockFactory: only deployer");
        _;
    }

    constructor(address minter_, address deployer_) {
        require(minter_   != address(0), "GitStockFactory: zero minter");
        require(deployer_ != address(0), "GitStockFactory: zero deployer");
        minter   = minter_;
        deployer = deployer_;
    }

    /**
     * @notice Deploy a new GitStockToken for a ticker.
     * @param ticker_  Uppercase ticker, e.g. "NVDA"
     * @param name_    Human-readable name, e.g. "Gitbank NVIDIA"
     * @param symbol_  Token symbol, e.g. "gitNVDA"
     * @return token   Address of the newly deployed GitStockToken
     */
    function deployStock(
        string calldata ticker_,
        string calldata name_,
        string calldata symbol_
    ) external onlyDeployer returns (address token) {
        require(bytes(ticker_).length > 0,             "GitStockFactory: empty ticker");
        require(stockByTicker[ticker_] == address(0),  "GitStockFactory: ticker already exists");

        token = address(new GitStockToken(name_, symbol_, ticker_, minter, address(this)));
        stockByTicker[ticker_] = token;
        _tickers.push(ticker_);

        emit GitStockDeployed(ticker_, token, name_, symbol_);
    }

    // ── View helpers ─────────────────────────────────────────────────────────

    /**
     * @notice Get the contract address for a ticker (address(0) if not deployed).
     */
    function getStock(string calldata ticker_) external view returns (address) {
        return stockByTicker[ticker_];
    }

    /**
     * @notice Returns true if a GitStockToken has been deployed for this ticker.
     */
    function hasStock(string calldata ticker_) external view returns (bool) {
        return stockByTicker[ticker_] != address(0);
    }

    /**
     * @notice Return all deployed tickers.
     */
    function allTickers() external view returns (string[] memory) {
        return _tickers;
    }

    /**
     * @notice Return total number of deployed stock tokens.
     */
    function stockCount() external view returns (uint256) {
        return _tickers.length;
    }
}
